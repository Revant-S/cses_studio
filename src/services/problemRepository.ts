import * as vscode from 'vscode';
import type { ConfigurationProvider } from '../core/config';
import type { Logger } from '../core/logger';
import type { ProblemIndex } from '../models/category';
import { DEFAULT_JUDGE, type JudgeId } from '../models/judge';
import type { Problem, ProblemSummary } from '../models/problem';
import type { CacheService } from './cache';
import type { ProblemSource } from './scraper';

export interface FetchOptions {
  /** Re-download statements that are already cached. */
  readonly force?: boolean;
  /** Also download every statement, not just the index. */
  readonly includeStatements?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number, label: string) => void;
}

/** The single source of problem data for the UI, across every judge. */
export class ProblemRepository {
  private readonly log: Logger;
  private readonly changed = new vscode.EventEmitter<void>();
  /** De-duplicates concurrent fetches, keyed by `judge/id`. */
  private readonly inFlight = new Map<string, Promise<Problem>>();

  readonly onDidChange = this.changed.event;

  constructor(
    private readonly sources: ReadonlyMap<JudgeId, ProblemSource>,
    private readonly cache: CacheService,
    private readonly config: ConfigurationProvider,
    logger: Logger,
  ) {
    this.log = logger.scoped('repository');
  }

  get judges(): JudgeId[] {
    return [...this.sources.keys()];
  }

  private sourceFor(judge: JudgeId): ProblemSource {
    const source = this.sources.get(judge);
    if (!source) {
      throw new Error(`No provider registered for judge "${judge}".`);
    }
    return source;
  }

  async getIndex(judge: JudgeId): Promise<ProblemIndex | undefined> {
    return this.cache.readIndex(judge);
  }

  /** Flattens a judge's cached index into a list, for search and lookups. */
  async allProblems(judge: JudgeId): Promise<ProblemSummary[]> {
    const index = await this.getIndex(judge);
    if (!index) {
      return [];
    }
    // Older caches predate the judge field; stamp it so callers can rely on it.
    return index.categories.flatMap((category) =>
      category.problems.map((problem) => ({ ...problem, judge: problem.judge ?? judge })),
    );
  }

  async findSummary(judge: JudgeId, id: string): Promise<ProblemSummary | undefined> {
    return (await this.allProblems(judge)).find((problem) => problem.id === id);
  }

  /** Searches every judge. */
  async findAnywhere(id: string): Promise<ProblemSummary | undefined> {
    for (const judge of this.judges) {
      const found = await this.findSummary(judge, id);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /** Returns a full statement, fetching and caching it on first access. */
  async getProblem(summary: ProblemSummary, force = false): Promise<Problem> {
    const judge = summary.judge ?? DEFAULT_JUDGE;
    const key = `${judge}/${summary.id}`;

    if (!force) {
      const cached = await this.cache.readProblem(judge, summary.id);
      if (cached) {
        return { ...cached, judge: cached.judge ?? judge };
      }
      const pending = this.inFlight.get(key);
      if (pending) {
        return pending;
      }
    }

    const request = this.sourceFor(judge)
      .fetchProblem(summary)
      .then(async (problem) => {
        const stamped = { ...problem, judge };
        await this.cache.writeProblem(judge, stamped);
        return stamped;
      })
      .finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, request);
    return request;
  }

  /** Refreshes one judge's index and, optionally, every statement. */
  async fetchAll(judge: JudgeId, options: FetchOptions = {}): Promise<ProblemIndex> {
    const index = await this.sourceFor(judge).fetchIndex(options.signal);
    await this.cache.writeIndex(judge, index);
    this.changed.fire();

    if (options.includeStatements) {
      await this.fetchStatements(judge, index, options);
    }
    return index;
  }

  /** Downloads statements with a bounded worker pool. */
  private async fetchStatements(
    judge: JudgeId,
    index: ProblemIndex,
    options: FetchOptions,
  ): Promise<void> {
    const targets: ProblemSummary[] = [];
    for (const category of index.categories) {
      for (const problem of category.problems) {
        if (options.force || !(await this.cache.hasProblem(judge, problem.id))) {
          targets.push({ ...problem, judge });
        }
      }
    }
    if (targets.length === 0) {
      return;
    }

    const total = targets.length;
    const workers = Math.max(1, Math.min(this.config.get().concurrency, 16));
    let cursor = 0;
    let done = 0;
    let failures = 0;

    this.log.info(`Fetching ${total} ${judge} statement(s) with ${workers} workers`);

    const worker = async (): Promise<void> => {
      for (;;) {
        if (options.signal?.aborted) {
          return;
        }
        const target = targets[cursor++];
        if (!target) {
          return;
        }
        try {
          const problem = await this.sourceFor(judge).fetchProblem(target, options.signal);
          await this.cache.writeProblem(judge, { ...problem, judge });
        } catch (error) {
          // One bad page must not abort a whole sync.
          failures += 1;
          this.log.warn(`Failed to fetch ${judge} problem ${target.id}: ${String(error)}`);
        } finally {
          done += 1;
          options.onProgress?.(done, total, target.title);
        }
      }
    };

    await Promise.all(Array.from({ length: workers }, worker));
    if (failures > 0) {
      this.log.warn(`${failures} of ${total} statements failed to download`);
    }
    this.changed.fire();
  }

  notifyChanged(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
