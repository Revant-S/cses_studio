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
import type { AtCoderAuthService } from './atcoderAuth';
import { extractCsrfToken } from './identity';
import type { CsesClient } from './csesClient';
import type { DiagnosticsRecorder } from './diagnostics';
import { type HTMLElement, normalizeText, parseHtml } from './html';

const CONTEST_ID = 'dp';
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;

export interface AtCoderSubmitRequest {
  /** Task screen name, e.g. `dp_a`. */
  readonly taskId: string;
  readonly code: string;
  readonly language: Language;
  /** Explicit AtCoder language id; 0 or undefined picks automatically. */
  readonly languageId?: number;
  readonly signal?: AbortSignal;
  readonly onStatus?: (status: string) => void;
}

/** One entry of the `data.LanguageId` select. */
export interface LanguageOption {
  readonly id: string;
  readonly label: string;
}

/** Submits to AtCoder and polls for the verdict. */
export class AtCoderSubmissionService {
  private readonly log: Logger;

  constructor(
    private readonly client: CsesClient,
    private readonly auth: AtCoderAuthService,
    logger: Logger,
    private readonly diagnostics?: DiagnosticsRecorder,
  ) {
    this.log = logger.scoped('atcoder-submit');
  }

  async submit(request: AtCoderSubmitRequest): Promise<SubmissionResult> {
    await this.auth.ensureAuthenticated();

    request.onStatus?.('Loading submission form…');
    const page = await this.client.get(`/contests/${CONTEST_ID}/submit`, {
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (/\/login/.test(page.url)) {
      throw new AuthError('AtCoder redirected the submit page to login. Sign in again.');
    }

    const token = extractCsrfToken(page.body);
    if (!token) {
      await this.capture('submit-form', page.url, page.status, page.body);
      throw new ParseError(
        'No CSRF token on the AtCoder submit page. The layout may have changed.',
      );
    }

    const languages = parseLanguageOptions(page.body);
    if (languages.length === 0) {
      await this.capture('submit-form', page.url, page.status, page.body);
      throw new ParseError(
        'Could not read the AtCoder language list. The submit page layout may have changed.',
      );
    }

    const languageId = String(
      request.languageId && request.languageId > 0
        ? request.languageId
        : (pickLanguageId(languages, request.language) ?? languages[0]?.id),
    );
    const chosen = languages.find((option) => option.id === languageId);
    this.log.info(
      `Submitting ${request.taskId} as ${chosen?.label ?? languageId} (id ${languageId})`,
    );

    request.onStatus?.('Uploading solution…');
    const response = await this.client.postForm(
      `/contests/${CONTEST_ID}/submit`,
      {
        csrf_token: token,
        'data.TaskScreenName': request.taskId,
        'data.LanguageId': languageId,
        sourceCode: request.code,
      },
      {
        ...(request.signal ? { signal: request.signal } : {}),
        timeoutMs: 45_000,
        referer: `/contests/${CONTEST_ID}/submit`,
      },
    );

    if (!/\/submissions\/me/.test(response.url)) {
      const captured = await this.capture(
        'submit-response',
        response.url,
        response.status,
        response.body,
      );
      const reason = extractFormError(response.body);
      throw new ParseError(
        `AtCoder did not accept the submission${reason ? `: ${reason}` : ''}.${
          captured ? ` Response saved to ${captured}.` : ''
        }`,
      );
    }

    const submissionId = findLatestSubmissionId(response.body, request.taskId);
    if (!submissionId) {
      await this.capture('submissions-list', response.url, response.status, response.body);
      throw new ParseError(
        'Submission was accepted but its id could not be read from the submissions list.',
      );
    }

    this.log.info(`AtCoder submission ${submissionId} accepted; polling`);
    return this.poll(submissionId, request);
  }

  /** Polls the submission list until the verdict stops being "waiting". */
  private async poll(
    submissionId: string,
    request: AtCoderSubmitRequest,
  ): Promise<SubmissionResult> {
    const url = this.client.resolve(`/contests/${CONTEST_ID}/submissions/${submissionId}`);
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let last: SubmissionResult | undefined;

    while (Date.now() < deadline) {
      if (request.signal?.aborted) {
        throw new AuthError('Submission polling cancelled.');
      }

      const response = await this.client.get(
        `/contests/${CONTEST_ID}/submissions/${submissionId}`,
        { ...(request.signal ? { signal: request.signal } : {}) },
      );
      last = parseSubmissionPage(submissionId, url, response.body);

      if (isTerminal(last.verdict)) {
        this.log.info(`AtCoder submission ${submissionId}: ${last.verdict}`);
        return last;
      }

      request.onStatus?.(last.rawVerdict || 'Judging…');
      await delay(POLL_INTERVAL_MS, request.signal);
    }

    this.log.warn(`AtCoder submission ${submissionId} did not settle in time`);
    return (
      last ?? {
        submissionId,
        url,
        verdict: Verdict.Pending,
        rawVerdict: 'Timed out waiting for the verdict',
        tests: [],
      }
    );
  }

  private async capture(
    label: string,
    url: string,
    status: number,
    body: string,
  ): Promise<string | undefined> {
    return this.diagnostics?.capture(`atcoder-${label}`, [
      { label: `atcoder ${label}`, status, url, body },
    ]);
  }
}

/** Reads the `data.LanguageId` options. */
export function parseLanguageOptions(html: string): LanguageOption[] {
  const root = parseHtml(html);
  const container = root.querySelector('#select-lang') ?? root;

  const select =
    container
      .querySelectorAll('select')
      .find((node) => node.getAttribute('name') === 'data.LanguageId') ??
    root.querySelectorAll('select').find((node) => node.getAttribute('name') === 'data.LanguageId');

  if (!select) {
    return [];
  }

  const options: LanguageOption[] = [];
  for (const option of select.querySelectorAll('option')) {
    const id = option.getAttribute('value')?.trim();
    const label = normalizeText(option.text);
    // The placeholder entry has an empty value.
    if (id && /^\d+$/.test(id)) {
      options.push({ id, label });
    }
  }
  return options;
}

/** Chooses a language id from the site's own list. */
export function pickLanguageId(
  options: readonly LanguageOption[],
  language: Language,
): string | undefined {
  const rank = (label: string): number => {
    const text = label.toLowerCase();
    if (language === 'cpp') {
      if (!/c\+\+/.test(text)) {
        return -1;
      }
      // Prefer GCC over Clang, and newer standards over older.
      let score = /gcc|g\+\+/.test(text) ? 100 : 50;
      const standard = /c\+\+\s*(\d{2})/.exec(text)?.[1];
      score += standard ? Number(standard) : 0;
      return score;
    }
    if (!/python|pypy/.test(text)) {
      return -1;
    }
    // PyPy first: CPython rarely fits AtCoder's limits on DP problems.
    let score = /pypy/.test(text) ? 100 : 50;
    if (/3/.test(text)) {
      score += 10;
    }
    return score;
  };

  let best: { id: string; score: number } | undefined;
  for (const option of options) {
    const score = rank(option.label);
    if (score >= 0 && (!best || score > best.score)) {
      best = { id: option.id, score };
    }
  }
  return best?.id;
}

/** Finds the newest submission id for a task in the submissions list. */
export function findLatestSubmissionId(html: string, taskId: string): string | undefined {
  const root = parseHtml(html);

  for (const row of root.querySelectorAll('tr')) {
    const links = row.querySelectorAll('a');
    const isOurTask = links.some((link) =>
      (link.getAttribute('href') ?? '').includes(`/tasks/${taskId}`),
    );
    if (!isOurTask) {
      continue;
    }
    for (const link of links) {
      const id = /\/submissions\/(\d+)/.exec(link.getAttribute('href') ?? '')?.[1];
      if (id) {
        return id;
      }
    }
  }

  const anyId = /\/submissions\/(\d+)/.exec(html)?.[1];
  return anyId;
}

/** Parses a submission detail page into a verdict. */
export function parseSubmissionPage(
  submissionId: string,
  url: string,
  html: string,
): SubmissionResult {
  const root = parseHtml(html);
  const summary = readSummary(root);

  const rawVerdict =
    normalizeText(root.querySelector('#judge-status')?.text ?? '') || summary.get('status') || '';
  const verdict = mapVerdict(rawVerdict);

  return {
    submissionId,
    url,
    verdict,
    rawVerdict: rawVerdict || 'UNKNOWN',
    ...(summary.get('exec time') ? { time: summary.get('exec time') as string } : {}),
    ...(summary.get('memory') ? { memory: summary.get('memory') as string } : {}),
    tests: readTestTable(root),
  };
}

function mapVerdict(text: string): Verdict {
  const value = text.trim().toUpperCase();
  if (!value) {
    return Verdict.Unknown;
  }
  // "WJ", "WR" and an "n/m" progress counter all mean still judging.
  if (/^(WJ|WR)\b/.test(value) || /^\d+\s*\/\s*\d+$/.test(value)) {
    return Verdict.Pending;
  }

  const abbreviations: Record<string, Verdict> = {
    AC: Verdict.Accepted,
    WA: Verdict.WrongAnswer,
    TLE: Verdict.TimeLimitExceeded,
    MLE: Verdict.MemoryLimitExceeded,
    RE: Verdict.RuntimeError,
    CE: Verdict.CompileError,
    OLE: Verdict.WrongAnswer,
    IE: Verdict.Unknown,
  };

  const token = value.split(/\s+/)[0] ?? '';
  return abbreviations[token] ?? parseVerdict(value);
}

function readSummary(root: HTMLElement): Map<string, string> {
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

/** Reads the per-case table AtCoder shows below a finished submission. */
function readTestTable(root: HTMLElement): TestResult[] {
  const tests: TestResult[] = [];
  let counter = 0;

  for (const row of root.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) {
      continue;
    }
    const name = normalizeText(cells[0]?.text ?? '');
    // Case names look like `00_sample_01.txt`, never a bare label.
    if (!/\.txt$/i.test(name) && !/^\d+_/.test(name)) {
      continue;
    }
    const verdict = mapVerdict(normalizeText(cells[1]?.text ?? ''));
    if (verdict === Verdict.Unknown) {
      continue;
    }
    counter += 1;
    const time = cells[2] ? normalizeText(cells[2].text) : undefined;
    tests.push({ test: counter, verdict, ...(time ? { time } : {}) });
  }
  return tests;
}

function extractFormError(html: string): string | undefined {
  const root = parseHtml(html);
  const alert = root.querySelector('.alert-danger');
  const text = alert ? normalizeText(alert.text) : '';
  return text || undefined;
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
