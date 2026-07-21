import { ParseError } from '../core/errors';
import type { Logger } from '../core/logger';
import type { Category, ProblemIndex } from '../models/category';
import { INDEX_VERSION } from '../models/category';
import { type Problem, ProblemStatus, type ProblemSummary } from '../models/problem';
import type { Sample } from '../models/sample';
import type { CsesClient } from './csesClient';
import { type HTMLElement, normalizeText, parseHtml, preformattedText, sanitizeHtml } from './html';

/** Everything that knows about cses.fi's markup lives here. */
export interface ProblemSource {
  fetchIndex(signal?: AbortSignal): Promise<ProblemIndex>;
  fetchProblem(summary: ProblemSummary, signal?: AbortSignal): Promise<Problem>;
  fetchSolvedStatuses(signal?: AbortSignal): Promise<Map<string, ProblemStatus>>;
}

export class CsesScraper implements ProblemSource {
  private readonly log: Logger;

  constructor(
    private readonly client: CsesClient,
    logger: Logger,
  ) {
    this.log = logger.scoped('scraper');
  }

  /** Scrapes the problem set index: every category and its problem links. */
  async fetchIndex(signal?: AbortSignal): Promise<ProblemIndex> {
    const response = await this.client.get('/problemset/', { signal });
    if (response.status !== 200) {
      throw new ParseError(`Problem set index returned HTTP ${response.status}`);
    }
    const categories = this.parseIndex(response.body);
    if (categories.length === 0) {
      throw new ParseError(
        'No categories found on the problem set page. The site layout may have changed.',
      );
    }
    this.log.info(
      `Indexed ${categories.length} categories, ${categories.reduce((n, c) => n + c.problems.length, 0)} problems`,
    );
    return { categories, fetchedAt: Date.now(), version: INDEX_VERSION };
  }

  private parseIndex(html: string): Category[] {
    const root = parseHtml(html);
    const content = root.querySelector('.content') ?? root;
    const categories: Category[] = [];
    let currentName: string | undefined;

    for (const node of content.querySelectorAll('h2, ul.task-list')) {
      if (node.rawTagName?.toLowerCase() === 'h2') {
        currentName = normalizeText(node.text);
        continue;
      }
      if (!currentName) {
        continue;
      }
      const problems = this.parseTaskList(node, currentName);
      if (problems.length > 0) {
        categories.push({ name: currentName, problems });
      }
    }
    return categories;
  }

  private parseTaskList(list: HTMLElement, category: string): ProblemSummary[] {
    const problems: ProblemSummary[] = [];
    for (const item of list.querySelectorAll('li.task')) {
      const link = item.querySelector('a');
      const href = link?.getAttribute('href');
      const id = href ? extractTaskId(href) : undefined;
      if (!link || !id) {
        continue;
      }
      const counts = parseCounts(item.querySelector('span.detail')?.text);
      problems.push({
        id,
        title: normalizeText(link.text),
        category,
        url: this.client.resolve(href as string),
        ...counts,
      });
    }
    return problems;
  }

  /** Fetches and parses one problem statement page. */
  async fetchProblem(summary: ProblemSummary, signal?: AbortSignal): Promise<Problem> {
    const response = await this.client.get(`/problemset/task/${summary.id}`, { signal });
    if (response.status !== 200) {
      throw new ParseError(`Problem ${summary.id} returned HTTP ${response.status}`);
    }
    return this.parseProblem(summary, response.body);
  }

  parseProblem(summary: ProblemSummary, html: string): Problem {
    const root = parseHtml(html);
    const md = root.querySelector('div.md');
    if (!md) {
      throw new ParseError(
        `Statement body (div.md) missing for problem ${summary.id}.`,
        summary.url,
      );
    }

    const limits = parseLimits(root);
    const sections = splitSections(sanitizeHtml(md));
    const samples = parseSamples(sections.get('example') ?? []);

    return {
      ...summary,
      statement: renderSection(sections.get('') ?? []),
      input: renderSection(sections.get('input') ?? sections.get('interaction') ?? []),
      output: renderSection(sections.get('output') ?? []),
      constraints: renderSection(sections.get('constraints') ?? []),
      notes: renderSection(sections.get('notes') ?? []),
      samples,
      ...limits,
      fetchedAt: Date.now(),
    };
  }

  /** Reads solve status from the index. */
  async fetchSolvedStatuses(signal?: AbortSignal): Promise<Map<string, ProblemStatus>> {
    const response = await this.client.get('/problemset/', { signal });
    const root = parseHtml(response.body);
    const statuses = new Map<string, ProblemStatus>();

    for (const item of root.querySelectorAll('li.task')) {
      const href = item.querySelector('a')?.getAttribute('href');
      const id = href ? extractTaskId(href) : undefined;
      if (!id) {
        continue;
      }
      const icon = item.querySelector('span.task-score');
      statuses.set(id, statusFromIconClass(icon?.getAttribute('class') ?? ''));
    }
    this.log.debug(`Read ${statuses.size} problem statuses`);
    return statuses;
  }
}

/** `full` means accepted; `zero` means submitted without a full score. */
export function statusFromIconClass(className: string): ProblemStatus {
  const classes = className.split(/\s+/);
  if (classes.includes('full')) {
    return ProblemStatus.Solved;
  }
  if (classes.includes('zero')) {
    return ProblemStatus.Attempted;
  }
  return ProblemStatus.Unsolved;
}

export function extractTaskId(href: string): string | undefined {
  return /\/task\/(\d+)/.exec(href)?.[1];
}

/** Parses the `1234 / 5678` solver/attempt counter shown beside each task. */
function parseCounts(text: string | undefined): {
  solvedCount?: number;
  attemptedCount?: number;
} {
  const match = text ? /(\d+)\s*\/\s*(\d+)/.exec(text) : null;
  if (!match) {
    return {};
  }
  return { solvedCount: Number(match[1]), attemptedCount: Number(match[2]) };
}

/** Reads `<ul class="task-constraints">`. */
function parseLimits(root: HTMLElement): { timeLimit?: number; memoryLimit?: number } {
  const text = root.querySelector('ul.task-constraints')?.text ?? '';
  const time = /Time limit:\s*([\d.]+)\s*s/i.exec(text);
  const memory = /Memory limit:\s*([\d.]+)\s*MB/i.exec(text);
  const limits: { timeLimit?: number; memoryLimit?: number } = {};
  if (time?.[1]) {
    limits.timeLimit = Number(time[1]);
  }
  if (memory?.[1]) {
    limits.memoryLimit = Number(memory[1]);
  }
  return limits;
}

function splitSections(md: HTMLElement): Map<string, HTMLElement[]> {
  const sections = new Map<string, HTMLElement[]>();
  let key = '';
  sections.set(key, []);

  for (const child of md.childNodes) {
    const element = child as HTMLElement;
    if (element.rawTagName?.toLowerCase() === 'h1') {
      key = (element.getAttribute('id') ?? normalizeText(element.text)).toLowerCase().trim();
      if (!sections.has(key)) {
        sections.set(key, []);
      }
      continue;
    }
    sections.get(key)?.push(element);
  }
  return sections;
}

function renderSection(nodes: readonly HTMLElement[]): string {
  return nodes
    .map((node) => node.toString())
    .join('')
    .trim();
}

/** Builds sample cases from the Example section. */
export function parseSamples(nodes: readonly HTMLElement[]): Sample[] {
  const samples: Sample[] = [];
  let pending: { input?: string; output?: string; explanation?: string } = {};

  const flush = (): void => {
    if (pending.input === undefined && pending.output === undefined) {
      return;
    }
    samples.push({
      index: samples.length + 1,
      input: pending.input ?? '',
      output: pending.output ?? '',
      ...(pending.explanation ? { explanation: pending.explanation } : {}),
    });
    pending = {};
  };

  let lastLabel = '';
  for (const node of nodes) {
    const tag = node.rawTagName?.toLowerCase();
    if (!tag) {
      continue;
    }
    if (tag === 'pre') {
      const content = preformattedText(node);
      if (lastLabel.startsWith('output')) {
        pending.output = content;
      } else {
        // An input while one is buffered means the previous sample ended.
        if (pending.input !== undefined) {
          flush();
        }
        pending.input = content;
      }
      lastLabel = '';
      continue;
    }
    const text = normalizeText(node.text);
    if (/^explanation/i.test(text)) {
      pending.explanation = text.replace(/^explanation:?\s*/i, '');
      continue;
    }
    if (text) {
      lastLabel = text.toLowerCase();
    }
  }
  flush();
  return samples;
}
