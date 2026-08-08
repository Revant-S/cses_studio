import * as vscode from 'vscode';
import type { Logger } from '../core/logger';
import type { ProblemIndex } from '../models/category';
import { DEFAULT_JUDGE, type JudgeId, problemKey } from '../models/judge';
import { ProblemStatus, type ProblemSummary } from '../models/problem';

/** Locally tracked activity for a single problem. */
export interface ProblemProgress {
  status: ProblemStatus;
  /** Epoch millis when the problem was first opened. */
  openedAt?: number;
  /** Epoch millis of the most recent submission attempt. */
  attemptedAt?: number;
  /** Failed attempts recorded so far. */
  attempts?: number;
  /** Epoch millis when it was first accepted. */
  solvedAt?: number;
  /** Flagged by the user to come back to, independent of solve state. */
  revisit?: boolean;
  /** Epoch millis when the revisit flag was set. */
  revisitAt?: number;
}

export interface CategoryProgress {
  readonly name: string;
  readonly solved: number;
  readonly attempted: number;
  readonly revisit: number;
  readonly total: number;
  /** Solved share in the range 0..1, precomputed for progress bars. */
  readonly ratio: number;
}

export interface ProgressSnapshot {
  readonly categories: readonly CategoryProgress[];
  readonly solved: number;
  readonly total: number;
  readonly lastSolved?: { id: string; at: number };
  readonly attempted: number;
  readonly revisit: number;
  readonly ratio: number;
}

const STORAGE_KEY = 'cses.progress.v1';

/** Tracks solved/attempted/opened state in the extension's global storage. */
export class ProgressService {
  private readonly log: Logger;
  private entries: Record<string, ProblemProgress>;
  private readonly changed = new vscode.EventEmitter<void>();

  /** Fires whenever any problem's progress changes. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly storage: vscode.Memento,
    logger: Logger,
  ) {
    this.log = logger.scoped('progress');
    this.entries = storage.get<Record<string, ProblemProgress>>(STORAGE_KEY, {});
  }

  /** Key for a problem. */
  keyOf(problem: Pick<ProblemSummary, 'id' | 'judge'>): string {
    return problemKey(problem.judge ?? DEFAULT_JUDGE, problem.id);
  }

  statusOf(id: string): ProblemStatus {
    return this.entries[id]?.status ?? ProblemStatus.Unsolved;
  }

  statusOfProblem(problem: Pick<ProblemSummary, 'id' | 'judge'>): ProblemStatus {
    return this.statusOf(this.keyOf(problem));
  }

  isProblemMarkedForRevision(problem: Pick<ProblemSummary, 'id' | 'judge'>): boolean {
    return this.isMarkedForRevision(this.keyOf(problem));
  }

  entryOf(id: string): ProblemProgress | undefined {
    return this.entries[id];
  }

  /** Failed attempts recorded against a problem. */
  attemptsOf(id: string): number {
    const entry = this.entries[id];
    if (!entry) {
      return 0;
    }
    return entry.attempts ?? (entry.attemptedAt !== undefined ? 1 : 0);
  }

  async markOpened(id: string): Promise<void> {
    const entry = this.ensure(id);
    if (entry.openedAt === undefined) {
      entry.openedAt = Date.now();
      await this.persist();
    }
  }

  async markAttempted(id: string): Promise<void> {
    const attempts = this.attemptsOf(id) + 1;
    const entry = this.ensure(id);
    entry.attemptedAt = Date.now();
    entry.attempts = attempts;
    // Never downgrade a solved problem because of a later failed experiment.
    if (entry.status !== ProblemStatus.Solved) {
      entry.status = ProblemStatus.Attempted;
    }
    await this.persist();
  }

  async markSolved(id: string): Promise<void> {
    const entry = this.ensure(id);
    entry.status = ProblemStatus.Solved;
    entry.solvedAt ??= Date.now();
    await this.persist();
  }

  /** Applies statuses scraped from the authenticated account. */
  async applyRemoteStatuses(statuses: ReadonlyMap<string, ProblemStatus>): Promise<number> {
    let changes = 0;
    for (const [id, remote] of statuses) {
      if (remote === ProblemStatus.Unsolved) {
        continue;
      }
      const entry = this.ensure(id);
      if (entry.status === remote) {
        continue;
      }
      if (entry.status === ProblemStatus.Solved && remote === ProblemStatus.Attempted) {
        continue;
      }
      entry.status = remote;
      if (remote === ProblemStatus.Solved) {
        entry.solvedAt ??= Date.now();
      }
      changes += 1;
    }
    if (changes > 0) {
      await this.persist();
    }
    this.log.info(`Synced ${changes} status change(s) from account`);
    return changes;
  }

  /** True when the user flagged this problem to revisit. */
  isMarkedForRevision(id: string): boolean {
    return this.entries[id]?.revisit === true;
  }

  /** Flips the revisit flag and returns its new value. */
  async toggleRevision(id: string): Promise<boolean> {
    const entry = this.ensure(id);
    const next = !entry.revisit;
    entry.revisit = next;
    if (next) {
      entry.revisitAt = Date.now();
    } else {
      delete entry.revisitAt;
    }
    await this.persist();
    return next;
  }

  /** Ids flagged for revision, most recently flagged first. */
  revisionList(): string[] {
    return Object.entries(this.entries)
      .filter(([, entry]) => entry.revisit)
      .sort(([, a], [, b]) => (b.revisitAt ?? 0) - (a.revisitAt ?? 0))
      .map(([id]) => id);
  }

  /** Aggregates per-category counts for the progress view. */
  snapshot(index: ProblemIndex | undefined, judge: JudgeId = DEFAULT_JUDGE): ProgressSnapshot {
    if (!index) {
      return { categories: [], solved: 0, total: 0, attempted: 0, revisit: 0, ratio: 0 };
    }
    const categories = index.categories.map((category) => {
      let solved = 0;
      let attempted = 0;
      let revisit = 0;
      for (const problem of category.problems) {
        const key = problemKey(problem.judge ?? judge, problem.id);
        const status = this.statusOf(key);
        if (status === ProblemStatus.Solved) {
          solved += 1;
        } else if (status === ProblemStatus.Attempted) {
          attempted += 1;
        }
        if (this.isMarkedForRevision(key)) {
          revisit += 1;
        }
      }
      const total = category.problems.length;
      return {
        name: category.name,
        solved,
        attempted,
        revisit,
        total,
        ratio: total > 0 ? solved / total : 0,
      };
    });

    const solved = categories.reduce((n, c) => n + c.solved, 0);
    const total = categories.reduce((n, c) => n + c.total, 0);
    return {
      categories,
      solved,
      total,
      attempted: categories.reduce((n, c) => n + c.attempted, 0),
      revisit: categories.reduce((n, c) => n + c.revisit, 0),
      ratio: total > 0 ? solved / total : 0,
      ...this.lastSolved(),
    };
  }

  private lastSolved(): { lastSolved?: { id: string; at: number } } {
    let best: { id: string; at: number } | undefined;
    for (const [id, entry] of Object.entries(this.entries)) {
      if (entry.solvedAt !== undefined && (!best || entry.solvedAt > best.at)) {
        best = { id, at: entry.solvedAt };
      }
    }
    return best ? { lastSolved: best } : {};
  }

  async reset(): Promise<void> {
    this.entries = {};
    await this.persist();
  }

  private ensure(id: string): ProblemProgress {
    let entry = this.entries[id];
    if (!entry) {
      entry = { status: ProblemStatus.Unsolved };
      this.entries[id] = entry;
    }
    return entry;
  }

  private async persist(): Promise<void> {
    await this.storage.update(STORAGE_KEY, this.entries);
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
