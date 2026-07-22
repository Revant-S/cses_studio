import { ParseError } from '../core/errors';
import type { Logger } from '../core/logger';
import type { Category, ProblemIndex } from '../models/category';
import { INDEX_VERSION } from '../models/category';
import { type Problem, ProblemStatus, type ProblemSummary } from '../models/problem';
import type { Sample } from '../models/sample';
import type { CsesClient } from './csesClient';
import { type HTMLElement, normalizeText, parseHtml, preformattedText, sanitizeHtml } from './html';
import type { ProblemSource } from './scraper';

export const ATCODER_ORIGIN = 'https://atcoder.jp';

/** The educational DP contest: 26 permanently open tasks, `dp_a` … `dp_z`. */
const CONTEST_ID = 'dp';
const CATEGORY_NAME = 'Educational DP Contest';

/** Scrapes the AtCoder Educational DP contest. */
export class AtCoderScraper implements ProblemSource {
  private readonly log: Logger;

  constructor(
    private readonly client: CsesClient,
    logger: Logger,
  ) {
    this.log = logger.scoped('atcoder');
  }

  /** Reads the contest task table: letter, title, and the two limits. */
  async fetchIndex(signal?: AbortSignal): Promise<ProblemIndex> {
    const response = await this.client.get(`/contests/${CONTEST_ID}/tasks`, { signal });
    if (response.status !== 200) {
      throw new ParseError(`AtCoder task list returned HTTP ${response.status}`);
    }

    const problems = this.parseTaskList(response.body);
    if (problems.length === 0) {
      throw new ParseError(
        'No tasks found on the AtCoder DP contest page. The site layout may have changed.',
      );
    }

    this.log.info(`Indexed ${problems.length} AtCoder DP tasks`);
    const category: Category = { name: CATEGORY_NAME, problems };
    return { categories: [category], fetchedAt: Date.now(), version: INDEX_VERSION };
  }

  parseTaskList(html: string): ProblemSummary[] {
    const root = parseHtml(html);
    const problems: ProblemSummary[] = [];

    for (const row of root.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) {
        continue;
      }
      const link = cells[1]?.querySelector('a') ?? cells[0]?.querySelector('a');
      const href = link?.getAttribute('href') ?? '';
      const id = /\/tasks\/([\w-]+)/.exec(href)?.[1];
      if (!id || !link) {
        continue;
      }

      const letter = normalizeText(cells[0]?.text ?? '');
      const title = normalizeText(link.text);
      problems.push({
        judge: 'atcoder-dp',
        id,
        // The letter is how these tasks are referred to; keep it in the title.
        title: letter && letter !== title ? `${letter} — ${title}` : title,
        category: CATEGORY_NAME,
        url: this.client.resolve(href),
      });
    }
    return problems;
  }

  async fetchProblem(summary: ProblemSummary, signal?: AbortSignal): Promise<Problem> {
    const response = await this.client.get(`/contests/${CONTEST_ID}/tasks/${summary.id}`, {
      signal,
    });
    if (response.status !== 200) {
      throw new ParseError(`AtCoder task ${summary.id} returned HTTP ${response.status}`);
    }
    return this.parseProblem(summary, response.body);
  }

  parseProblem(summary: ProblemSummary, html: string): Problem {
    const root = parseHtml(html);
    const statementRoot = root.querySelector('#task-statement');
    if (!statementRoot) {
      throw new ParseError(
        `Statement body (#task-statement) missing for ${summary.id}.`,
        summary.url,
      );
    }

    const english = statementRoot.querySelector('span.lang-en') ?? statementRoot;
    const sections = splitSections(sanitizeHtml(english));
    const limits = parseLimits(root);

    return {
      ...summary,
      judge: 'atcoder-dp',
      statement: renderSection(sections.get('problem statement') ?? sections.get('') ?? []),
      input: renderSection(sections.get('input') ?? []),
      output: renderSection(sections.get('output') ?? []),
      constraints: renderSection(sections.get('constraints') ?? []),
      notes: renderSection(sections.get('notes') ?? []),
      samples: parseSamples(sections),
      ...limits,
      fetchedAt: Date.now(),
    };
  }

  async fetchSolvedStatuses(): Promise<Map<string, ProblemStatus>> {
    return new Map();
  }
}

/** Buckets the statement by `<h3>` heading. */
function splitSections(root: HTMLElement): Map<string, HTMLElement[]> {
  const sections = new Map<string, HTMLElement[]>();

  for (const section of root.querySelectorAll('section')) {
    const heading = section.querySelector('h3');
    const key = heading ? normalizeText(heading.text).toLowerCase() : '';
    const body = section.childNodes.filter(
      (node) => (node as HTMLElement) !== heading,
    ) as HTMLElement[];

    const existing = sections.get(key);
    if (existing) {
      existing.push(...body);
    } else {
      sections.set(key, body);
    }
  }
  return sections;
}

/** Pairs `Sample Input N` with `Sample Output N`. */
function parseSamples(sections: ReadonlyMap<string, HTMLElement[]>): Sample[] {
  const inputs = new Map<number, string>();
  const outputs = new Map<number, string>();
  const explanations = new Map<number, string>();

  for (const [heading, nodes] of sections) {
    const match = /^sample (input|output)\s*(\d+)/.exec(heading);
    if (!match) {
      continue;
    }
    const index = Number(match[2]);
    const pre = nodes.find((node) => node.rawTagName?.toLowerCase() === 'pre');
    if (!pre) {
      continue;
    }

    if (match[1] === 'input') {
      inputs.set(index, preformattedText(pre));
    } else {
      outputs.set(index, preformattedText(pre));
      // Any prose after the expected output explains the case.
      const note = nodes
        .filter((node) => node.rawTagName?.toLowerCase() === 'p')
        .map((node) => normalizeText(node.text))
        .join(' ')
        .trim();
      if (note) {
        explanations.set(index, note);
      }
    }
  }

  return [...new Set([...inputs.keys(), ...outputs.keys()])]
    .sort((a, b) => a - b)
    .map((index) => {
      const explanation = explanations.get(index);
      return {
        index,
        input: inputs.get(index) ?? '',
        output: outputs.get(index) ?? '',
        ...(explanation ? { explanation } : {}),
      };
    });
}

/** Reads "Time Limit: 2 sec / Memory Limit: 1024 MiB". */
function parseLimits(root: HTMLElement): { timeLimit?: number; memoryLimit?: number } {
  const text = root.text;
  const time = /Time Limit:\s*([\d.]+)\s*sec/i.exec(text);
  const memory = /Memory Limit:\s*([\d.]+)\s*(MiB|MB)/i.exec(text);

  const limits: { timeLimit?: number; memoryLimit?: number } = {};
  if (time?.[1]) {
    limits.timeLimit = Number(time[1]);
  }
  if (memory?.[1]) {
    limits.memoryLimit = Number(memory[1]);
  }
  return limits;
}

function renderSection(nodes: readonly HTMLElement[]): string {
  return convertVarToMath(
    nodes
      .map((node) => node.toString())
      .join('')
      .trim(),
  );
}

export function convertVarToMath(html: string): string {
  return html.replace(
    /<var>([\s\S]*?)<\/var>/gi,
    (_, body: string) =>
      `<span class="math math-inline">${body.replace(/<[^>]+>/g, '').trim()}</span>`,
  );
}
