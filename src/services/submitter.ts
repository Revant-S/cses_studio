import * as path from 'path';
import type { Language } from '../core/config';
import { AuthError, ParseError } from '../core/errors';
import type { Logger } from '../core/logger';
import {
  isTerminal,
  parseVerdict,
  type SubmissionResult,
  type TestResult,
  Verdict,
} from '../models/verdict';
import type { AuthService } from './auth';
import type { CsesClient } from './csesClient';
import type { CapturedPage, DiagnosticsRecorder } from './diagnostics';
import { type HTMLElement, normalizeText, parseHtml, preformattedText } from './html';
import { parseIdentity } from './identity';

export interface SubmitRequest {
  readonly problemId: string;
  readonly sourceFile: string;
  readonly code: string;
  readonly language: Language;
  readonly signal?: AbortSignal;
  readonly onStatus?: (status: string) => void;
}

/** A `<form>` reduced to what is needed to replay it. */
interface DiscoveredForm {
  readonly action: string;
  readonly fields: Record<string, string>;
  readonly fileField: string;
  readonly languageField?: string;
  readonly languageOptions: string[];
  readonly optionField?: string;
  readonly optionValues: string[];
  /** Compiler variants declared by the page's script, keyed by language. */
  readonly scriptOptions?: ScriptOptions;
}

const POLL_INTERVAL_MS = 1200;
const POLL_TIMEOUT_MS = 120_000;

/** Submits solutions to CSES and polls for the verdict. */
export class SubmissionService {
  private readonly log: Logger;

  constructor(
    private readonly client: CsesClient,
    private readonly auth: AuthService,
    logger: Logger,
    private readonly diagnostics?: DiagnosticsRecorder,
  ) {
    this.log = logger.scoped('submit');
  }

  async submit(request: SubmitRequest): Promise<SubmissionResult> {
    await this.auth.ensureAuthenticated();

    request.onStatus?.('Loading submission form…');
    const { form, page: submitPage } = await this.loadSubmitForm(request.problemId, request.signal);

    const fields = { ...form.fields };
    const language = pickLanguage(form.languageOptions, request.language);
    if (form.languageField) {
      fields[form.languageField] = language;
    }
    if (form.optionField) {
      const option = pickCompilerOption(
        form.optionValues,
        request.language,
        form.scriptOptions,
        language,
      );
      if (option) {
        fields[form.optionField] = option;
      }
    }

    this.log.info(
      `Submitting ${path.basename(request.sourceFile)} to task ${request.problemId} as ${language}${
        form.optionField && fields[form.optionField] ? ` (${fields[form.optionField]})` : ''
      }`,
    );

    request.onStatus?.('Uploading solution…');
    const response = await this.client.postMultipart(
      form.action,
      fields,
      {
        field: form.fileField,
        filename: path.basename(request.sourceFile),
        content: request.code,
        contentType: 'text/plain',
      },
      {
        ...(request.signal ? { signal: request.signal } : {}),
        timeoutMs: 45_000,
        referer: `/problemset/submit/${request.problemId}/`,
      },
    );

    const submissionId = extractSubmissionId(response.url, response.body);
    if (!submissionId) {
      // Record what actually came back before interpreting it.
      const page = parseHtml(response.body);
      const diagnosis = describePage(page, response.status, response.url);
      this.log.warn(
        `Upload to ${form.action} returned no result link. ${diagnosis} Posted fields: ${Object.keys(fields).join(', ') || 'none'}; file field "${form.fileField}".`,
      );

      // Save both stages: the form we read and the reply we could not parse.
      const captured = await this.diagnostics?.capture(`upload-${request.problemId}`, [
        submitPage,
        {
          label: 'upload response',
          status: response.status,
          url: response.url,
          body: response.body,
        },
      ]);
      const where = captured ? ` Full request/response saved to ${captured}.` : '';

      // A missing account link means the reply was not a normal signed-in page.
      const signedOut = !parseIdentity(response.body);
      throw new ParseError(
        `CSES accepted the upload but returned no result link${
          signedOut ? ' and the reply was not a normal signed-in page' : ''
        }. ${diagnosis}${where}`,
      );
    }

    this.log.info(`Submission ${submissionId} accepted; polling for verdict`);
    return this.pollResult(submissionId, request);
  }

  /** Downloads the test data for every failed test in a submission. */
  async fetchFailedTestData(
    result: SubmissionResult,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<TestResult[]> {
    const limit = options.limit ?? 10;
    const failed = result.tests.filter((test) => test.verdict !== Verdict.Accepted);
    if (failed.length === 0) {
      return [];
    }

    const enriched: TestResult[] = [];
    for (const test of failed.slice(0, limit)) {
      if (options.signal?.aborted) {
        break;
      }
      if (!test.detailUrl) {
        enriched.push(test);
        continue;
      }

      try {
        const response = await this.client.get(test.detailUrl, {
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const detail = parseTestDetail(response.body);

        if (detail.input === undefined) {
          this.log.warn(`Test ${test.test} detail page had no readable input (${test.detailUrl}).`);
          await this.diagnostics?.capture(`test-detail-${result.submissionId}-${test.test}`, [
            {
              label: `test ${test.test} detail`,
              status: response.status,
              url: response.url,
              body: response.body,
            },
          ]);
        }

        enriched.push({ ...test, ...detail });
      } catch (error) {
        this.log.warn(`Could not load test ${test.test} details: ${String(error)}`);
        enriched.push(test);
      }
    }

    const withData = enriched.filter((test) => test.input !== undefined).length;
    this.log.info(`Recovered data for ${withData} of ${failed.length} failed test(s)`);
    return enriched;
  }

  /** Fetches and parses the submit form for a task. */
  private async loadSubmitForm(
    problemId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ form: DiscoveredForm; page: CapturedPage }> {
    const response = await this.client.get(`/problemset/submit/${problemId}/`, {
      ...(signal ? { signal } : {}),
    });

    const page: CapturedPage = {
      label: `submit page for task ${problemId}`,
      status: response.status,
      url: response.url,
      body: response.body,
    };

    if (response.status === 404 || /you must be logged in/i.test(response.body)) {
      throw new AuthError('CSES did not serve the submit page. Sign in again and retry.');
    }

    const root = parseHtml(response.body);
    const form = findUploadForm(root);
    if (!form) {
      const diagnosis = describePage(root, response.status, response.url);
      this.log.warn(`Submit page for task ${problemId} had no upload form. ${diagnosis}`);
      const captured = await this.diagnostics?.capture(`submit-page-${problemId}`, [page]);

      throw new ParseError(
        `No file upload form found on the submit page for task ${problemId}. ${diagnosis}${
          captured ? ` Response saved to ${captured}.` : ''
        }`,
      );
    }

    return {
      form: {
        ...form,
        action: form.action
          ? this.client.resolve(form.action)
          : this.client.resolve('/course/send.php'),
      },
      page,
    };
  }

  /** Polls the result page until the verdict settles. */
  private async pollResult(
    submissionId: string,
    request: SubmitRequest,
  ): Promise<SubmissionResult> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let last: SubmissionResult | undefined;

    while (Date.now() < deadline) {
      if (request.signal?.aborted) {
        throw new AuthError('Submission polling cancelled.');
      }

      const response = await this.client.get(`/problemset/result/${submissionId}/`, {
        ...(request.signal ? { signal: request.signal } : {}),
      });
      last = parseResultPage(
        submissionId,
        this.client.resolve(`/problemset/result/${submissionId}/`),
        response.body,
      );

      if (isTerminal(last.verdict)) {
        this.log.info(
          `Submission ${submissionId}: ${last.verdict} (${last.tests.length} test row(s) parsed)`,
        );

        if (last.verdict !== Verdict.Accepted && last.tests.length === 0) {
          const captured = await this.diagnostics?.capture(`result-${submissionId}`, [
            {
              label: `result page for submission ${submissionId}`,
              status: response.status,
              url: response.url,
              body: response.body,
            },
          ]);
          this.log.warn(
            `No per-test rows found on the result page for ${submissionId}; failing tests cannot be imported.${
              captured ? ` Page saved to ${captured}.` : ''
            }`,
          );
        }
        return last;
      }

      request.onStatus?.(last.rawVerdict || 'Judging…');
      await delay(POLL_INTERVAL_MS, request.signal);
    }

    this.log.warn(`Submission ${submissionId} did not settle within ${POLL_TIMEOUT_MS}ms`);
    return (
      last ?? {
        submissionId,
        url: this.client.resolve(`/problemset/result/${submissionId}/`),
        verdict: Verdict.Pending,
        rawVerdict: 'Timed out waiting for the verdict',
        tests: [],
      }
    );
  }
}

/** Finds the upload form. */
export function findUploadForm(
  root: HTMLElement,
): (Omit<DiscoveredForm, 'action'> & { action: string }) | undefined {
  for (const form of root.querySelectorAll('form')) {
    if (findFileInput(form)) {
      return readForm(form, form.getAttribute('action') ?? '', false, parseScriptOptions(root));
    }
  }
  // Fall back to the document itself when the form wrapper is absent.
  return findFileInput(root) ? readForm(root, '', true, parseScriptOptions(root)) : undefined;
}

/** Extracts the postable fields from a form-like container. */
function readForm(
  container: HTMLElement,
  action: string,
  hiddenOnly: boolean,
  scriptOptions: ScriptOptions,
): Omit<DiscoveredForm, 'action'> & { action: string } {
  const fileInput = findFileInput(container);

  const fields: Record<string, string> = {};
  for (const input of container.querySelectorAll('input')) {
    const name = input.getAttribute('name');
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();
    if (!name || type === 'file' || type === 'submit' || type === 'button') {
      continue;
    }
    if (hiddenOnly && type !== 'hidden') {
      continue;
    }
    if ((type === 'checkbox' || type === 'radio') && input.getAttribute('checked') === null) {
      continue;
    }
    fields[name] = input.getAttribute('value') ?? '';
  }

  const selects = container.querySelectorAll('select');
  const languageSelect = selects.find((select) => /lang/i.test(select.getAttribute('name') ?? ''));
  const optionSelect = selects.find((select) =>
    /option|compiler|version/i.test(select.getAttribute('name') ?? ''),
  );

  // Any select we do not specifically handle still needs its default posted.
  for (const select of selects) {
    const name = select.getAttribute('name');
    if (!name || select === languageSelect || select === optionSelect) {
      continue;
    }
    const first = optionValues(select)[0];
    if (first !== undefined) {
      fields[name] = first;
    }
  }

  return {
    action,
    fields,
    fileField: fileInput?.getAttribute('name') ?? 'file',
    ...(languageSelect?.getAttribute('name')
      ? { languageField: languageSelect.getAttribute('name') as string }
      : {}),
    languageOptions: languageSelect ? optionValues(languageSelect) : [],
    ...(optionSelect?.getAttribute('name')
      ? { optionField: optionSelect.getAttribute('name') as string }
      : {}),
    optionValues: optionSelect ? optionValues(optionSelect) : [],
    scriptOptions,
  };
}

/** Compiler options as the submit page's own script defines them. */
export interface ScriptOptions {
  /** Language name to its available compiler variants. */
  readonly options: Record<string, string[]>;
  /** Language name to the variant the site pre-selects. */
  readonly defaults: Record<string, string>;
}

export function parseScriptOptions(root: HTMLElement): ScriptOptions {
  const source = root
    .querySelectorAll('script')
    .map((script) => script.text)
    .join('\n');

  return {
    options: readJsonLiteral(source, 'options'),
    defaults: readJsonLiteral(source, 'defaults'),
  };
}

/** Reads `var <name> = { ... }` from script source. */
function readJsonLiteral<T>(source: string, name: string): Record<string, T> {
  const start = new RegExp(`var\\s+${name}\\s*=\\s*`).exec(source);
  if (!start) {
    return {};
  }

  const from = start.index + start[0].length;
  if (source[from] !== '{') {
    return {};
  }

  // Scan to the matching brace; the values may themselves be arrays or objects.
  let depth = 0;
  let inString = false;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (char === '\\') {
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(from, i + 1)) as Record<
            T extends never ? never : string,
            T
          >;
        } catch {
          return {};
        }
      }
    }
  }
  return {};
}

function findFileInput(form: HTMLElement): HTMLElement | undefined {
  return form
    .querySelectorAll('input')
    .find((input) => (input.getAttribute('type') ?? '').toLowerCase() === 'file');
}

function describePage(root: HTMLElement, status: number, url: string): string {
  const title = normalizeText(root.querySelector('title')?.text ?? '') || '(no title)';
  const forms = root.querySelectorAll('form').length;
  const inputs = root.querySelectorAll('input');
  const account = root.querySelector('a.account')?.getAttribute('href') ?? '(none)';
  const heading = normalizeText(root.querySelector('h1')?.text ?? '') || '(no h1)';

  const inventory = inputs
    .map((input) => {
      const type = (input.getAttribute('type') ?? 'text').toLowerCase();
      const name = input.getAttribute('name') ?? '?';
      return `${type}:${name}`;
    })
    .join(', ');
  const selects = root
    .querySelectorAll('select')
    .map((select) => select.getAttribute('name') ?? '?')
    .join(', ');

  return `HTTP ${status} ${url} — title "${title}", h1 "${heading}", ${forms} form(s), ${inputs.length} input(s) [${inventory || 'none'}], select(s) [${selects || 'none'}], account link ${account}.`;
}

function optionValues(select: HTMLElement): string[] {
  return select
    .querySelectorAll('option')
    .map((option) => option.getAttribute('value') ?? normalizeText(option.text))
    .filter((value) => value.length > 0);
}

/** Chooses the site's own label for the configured language. */
export function pickLanguage(available: readonly string[], language: Language): string {
  const wanted = language === 'cpp' ? /^c\+\+/i : /^python/i;
  return available.find((value) => wanted.test(value)) ?? (language === 'cpp' ? 'C++' : 'Python');
}

/** Picks a compiler variant. */
export function pickCompilerOption(
  available: readonly string[],
  language: Language,
  scriptOptions?: ScriptOptions,
  siteLanguage?: string,
): string | undefined {
  // The served `<select>` is empty.
  const key = siteLanguage ?? (language === 'cpp' ? 'C++' : 'Python3');
  const fromScript = scriptOptions?.options[key] ?? [];
  const siteDefault = scriptOptions?.defaults[key];
  if (siteDefault && fromScript.includes(siteDefault)) {
    return siteDefault;
  }

  const choices = available.length > 0 ? available : fromScript;
  if (choices.length === 0) {
    return undefined;
  }

  if (language === 'cpp') {
    for (const standard of ['C++20', 'C++17', 'C++11']) {
      const match = choices.find((value) => value.replace(/\s/g, '').includes(standard));
      if (match) {
        return match;
      }
    }
  } else {
    const cpython = choices.find((value) => /cpython/i.test(value));
    if (cpython) {
      return cpython;
    }
  }
  return choices[0];
}

/** Result pages live at `/problemset/result/<id>/`; the id may arrive via redirect or link. */
export function extractSubmissionId(url: string, body: string): string | undefined {
  const fromUrl = /\/result\/(\d+)/.exec(url)?.[1];
  if (fromUrl) {
    return fromUrl;
  }
  return /\/result\/(\d+)/.exec(body)?.[1];
}

/** Parses a submission result page. */
export function parseResultPage(submissionId: string, url: string, html: string): SubmissionResult {
  const root = parseHtml(html);
  const summary = readSummaryRows(root);

  const rawVerdict = summary.get('result') ?? summary.get('verdict') ?? summary.get('status') ?? '';
  const verdict = parseVerdict(rawVerdict);

  const compilerOutput = readCompilerOutput(root);
  const tests = readTestTable(root);

  const effective =
    verdict === Verdict.Unknown && compilerOutput?.isError ? Verdict.CompileError : verdict;

  return {
    submissionId,
    url,
    verdict: effective,
    rawVerdict: rawVerdict || (compilerOutput?.isError ? 'COMPILE ERROR' : 'UNKNOWN'),
    ...(summary.get('time') ? { time: summary.get('time') as string } : {}),
    ...(summary.get('memory') ? { memory: summary.get('memory') as string } : {}),
    ...(compilerOutput ? { compilerOutput: compilerOutput.text } : {}),
    tests,
  };
}

function readSummaryRows(root: HTMLElement): Map<string, string> {
  const values = new Map<string, string>();
  for (const row of root.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('td, th');
    if (cells.length < 2) {
      continue;
    }
    const label = normalizeText(cells[0]?.text ?? '')
      .replace(/:$/, '')
      .toLowerCase();
    const value = normalizeText(cells[1]?.text ?? '');
    if (label && value && !values.has(label)) {
      values.set(label, value);
    }
  }
  return values;
}

/** Reads the compiler's own output, distinguishing errors from warnings. */
function readCompilerOutput(root: HTMLElement): { text: string; isError: boolean } | undefined {
  for (const pre of root.querySelectorAll('pre')) {
    const text = pre.text.trim();
    if (!text) {
      continue;
    }
    // gcc prefixes real failures with "error:"; "warning:" and "note:" are not.
    const isError = /\berror\b\s*:/i.test(text) || /\berrors?\b/i.test(text.split('\n')[0] ?? '');
    if (isError || /\b(warning|note)\s*:/i.test(text)) {
      return { text, isError };
    }
  }
  return undefined;
}

/** Reads the per-test table, when the page shows one. */
function readTestTable(root: HTMLElement): TestResult[] {
  const tests: TestResult[] = [];
  for (const row of root.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) {
      continue;
    }
    const testNumber = /^#?(\d+)$/.exec(normalizeText(cells[0]?.text ?? ''))?.[1];
    if (!testNumber) {
      continue;
    }
    const verdictText = normalizeText(cells[1]?.text ?? '');
    const verdict = parseVerdict(verdictText);
    if (verdict === Verdict.Unknown) {
      continue;
    }
    const time = cells[2] ? normalizeText(cells[2].text) : undefined;
    // The row usually links to a per-test page holding the actual test data.
    const detailUrl = row.querySelector('a')?.getAttribute('href') ?? undefined;

    tests.push({
      test: Number(testNumber),
      verdict,
      ...(time ? { time } : {}),
      ...(detailUrl ? { detailUrl } : {}),
    });
  }
  return tests;
}

/** Labels CSES uses on a test detail page, mapped to the field they precede. */
const DETAIL_SECTIONS: ReadonlyArray<
  readonly [RegExp, 'input' | 'expectedOutput' | 'actualOutput']
> = [
  [/^input/i, 'input'],
  [/^(correct output|expected output|answer)/i, 'expectedOutput'],
  [/^(your output|user output|output)/i, 'actualOutput'],
];

/** Parses a single test's detail page into replayable data. */
export function parseTestDetail(html: string): {
  input?: string;
  expectedOutput?: string;
  actualOutput?: string;
  truncated: boolean;
} {
  const root = parseHtml(html);
  const result: {
    input?: string;
    expectedOutput?: string;
    actualOutput?: string;
    truncated: boolean;
  } = { truncated: false };

  const content = root.querySelector('.content') ?? root;
  let field: 'input' | 'expectedOutput' | 'actualOutput' | undefined;

  for (const node of content.querySelectorAll('h1, h2, h3, h4, p, pre, div')) {
    const tag = node.rawTagName?.toLowerCase();

    if (tag === 'pre') {
      if (field && result[field] === undefined) {
        result[field] = preformattedText(node);
      }
      field = undefined;
      continue;
    }

    // Only look at a node's own label text, not its descendants'.
    const text = normalizeText(node.text).slice(0, 60);
    if (/truncated/i.test(text)) {
      result.truncated = true;
    }
    const match = DETAIL_SECTIONS.find(([pattern]) => pattern.test(text));
    if (match) {
      field = match[1];
    }
  }

  return result;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
