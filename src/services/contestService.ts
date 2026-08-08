import * as vscode from 'vscode';
import type { Logger } from '../core/logger';
import {
  type Contest,
  type ContestEndReason,
  type ContestProblem,
  type ContestSnapshot,
  MAX_CONTEST_MINUTES,
  MAX_CONTEST_PROBLEMS,
  MIN_CONTEST_MINUTES,
  MIN_CONTEST_PROBLEMS,
  type PickReason,
  elapsedMs,
  remainingMs,
  solvedCount,
} from '../models/contest';
import { DEFAULT_JUDGE, type JudgeId } from '../models/judge';
import { ProblemStatus, type ProblemSummary } from '../models/problem';
import { type Candidate, pickContestProblems, summarizeCandidates } from './contestPicker';
import type { ProblemRepository } from './problemRepository';
import type { ProgressService } from './progress';

const ACTIVE_KEY = 'cses.contest.active.v1';
const HISTORY_KEY = 'cses.contest.history.v1';
const HISTORY_LIMIT = 20;
/** The clock only needs to be right to the second the user is reading. */
const TICK_MS = 1000;

export interface StartContestOptions {
  readonly judge: JudgeId;
  /** Category names to draw from. */
  readonly topics: readonly string[];
  readonly count: number;
  readonly durationMinutes: number;
  /** Include problems already solved cleanly. */
  readonly includeSolved?: boolean;
}

/** One topic as the setup screen shows it, with its eligible-problem breakdown. */
export interface TopicOption {
  readonly name: string;
  readonly total: number;
  readonly eligible: number;
  readonly counts: Record<PickReason, number>;
}

export class ContestService implements vscode.Disposable {
  private readonly log: Logger;
  private readonly changed = new vscode.EventEmitter<Contest | undefined>();
  private readonly ticked = new vscode.EventEmitter<ContestSnapshot>();
  private readonly disposables: vscode.Disposable[] = [];

  private current: Contest | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Fires when a contest starts, ends, or a problem's state changes. */
  readonly onDidChange = this.changed.event;
  /** Fires once a second while a contest runs, for the clock. */
  readonly onDidTick = this.ticked.event;

  constructor(
    private readonly storage: vscode.Memento,
    private readonly repository: ProblemRepository,
    private readonly progress: ProgressService,
    logger: Logger,
  ) {
    this.log = logger.scoped('contest');
    this.disposables.push(this.progress.onDidChange(() => void this.syncSolved()));
  }

  get active(): Contest | undefined {
    return this.current;
  }

  /** True while a contest is running and its deadline is still ahead. */
  get isRunning(): boolean {
    return this.current !== undefined && this.current.endedAt === undefined;
  }

  /** Reloads any contest left running by the previous session. */
  async restore(): Promise<void> {
    const stored = this.storage.get<Contest | undefined>(ACTIVE_KEY, undefined);
    if (!stored || !Array.isArray(stored.problems)) {
      return;
    }
    if (stored.endedAt !== undefined) {
      this.current = undefined;
      await this.storage.update(ACTIVE_KEY, undefined);
      return;
    }

    this.current = stored;
    this.log.info(`Restored contest ${stored.id} with ${stored.problems.length} problem(s)`);

    if (remainingMs(stored) <= 0) {
      await this.finish('timeout', stored.startedAt + stored.durationMs);
      return;
    }
    await this.syncSolved();
    this.startClock();
    this.changed.fire(this.current);
  }

  /** Categories available for the given judge, with their eligible counts. */
  async topics(judge: JudgeId, includeSolved = false): Promise<TopicOption[]> {
    const index = await this.repository.getIndex(judge);
    if (!index) {
      return [];
    }
    return index.categories.map((category) => {
      const candidates = this.candidatesFor(category.problems, judge, includeSolved);
      return {
        name: category.name,
        total: category.problems.length,
        eligible: candidates.length,
        counts: summarizeCandidates(candidates),
      };
    });
  }

  /** Drafts the problems a contest with these options would contain, without starting it. */
  async draft(options: StartContestOptions): Promise<ContestProblem[]> {
    const count = clamp(options.count, MIN_CONTEST_PROBLEMS, MAX_CONTEST_PROBLEMS);
    const pool = await this.pool(options);
    if (pool.length === 0) {
      return [];
    }

    return pickContestProblems(pool, count).map((picked) => ({
      key: this.progress.keyOf(picked.item),
      judge: picked.item.judge ?? options.judge,
      id: picked.item.id,
      title: picked.item.title,
      category: picked.item.category,
      url: picked.item.url,
      reason: picked.reason,
      priorAttempts: picked.attempts,
    }));
  }

  /** Starts a contest, replacing any that is already running. */
  async start(options: StartContestOptions): Promise<Contest> {
    const problems = await this.draft(options);
    if (problems.length === 0) {
      throw new Error(
        options.topics.length > 0
          ? 'No problems match the selected topics. Try more topics, or allow solved problems.'
          : 'No problems are cached for this site yet — fetch the problem list first.',
      );
    }

    if (this.current && this.current.endedAt === undefined) {
      await this.finish('abandoned');
    }

    const durationMinutes = clamp(
      options.durationMinutes,
      MIN_CONTEST_MINUTES,
      MAX_CONTEST_MINUTES,
    );
    const contest: Contest = {
      id: `c${Date.now().toString(36)}`,
      judge: options.judge,
      topics: [...options.topics],
      startedAt: Date.now(),
      durationMs: durationMinutes * 60_000,
      problems,
    };

    this.current = contest;
    await this.persist();
    this.startClock();
    this.log.info(
      `Started contest ${contest.id}: ${problems.length} problem(s), ${durationMinutes} min, ` +
        `topics=${contest.topics.length > 0 ? contest.topics.join(', ') : 'all'}`,
    );
    this.changed.fire(contest);
    return contest;
  }

  /** Ends the running contest early. */
  async end(reason: ContestEndReason = 'abandoned'): Promise<Contest | undefined> {
    if (!this.current || this.current.endedAt !== undefined) {
      return undefined;
    }
    return this.finish(reason);
  }

  /** Drops a finished contest from view, returning the UI to setup. */
  dismissRecap(): void {
    if (this.current?.endedAt === undefined) {
      return;
    }
    this.current = undefined;
    this.changed.fire(undefined);
  }

  /** Records that a contest problem was opened, for the recap's timing. */
  async markOpened(problemId: string): Promise<void> {
    const problem = this.current?.problems.find((entry) => entry.id === problemId);
    if (!problem || problem.openedAt !== undefined || !this.isRunning) {
      return;
    }
    problem.openedAt = Date.now();
    await this.persist();
    this.changed.fire(this.current);
  }

  /** The next unsolved problem, for "jump to what's left". */
  nextUnsolved(): ContestProblem | undefined {
    return this.current?.problems.find((problem) => problem.solvedAt === undefined);
  }

  snapshot(now = Date.now()): ContestSnapshot | undefined {
    const contest = this.current;
    if (!contest) {
      return undefined;
    }
    return {
      contest,
      remainingMs: remainingMs(contest, now),
      elapsedMs: elapsedMs(contest, now),
      solved: solvedCount(contest),
      total: contest.problems.length,
      running: contest.endedAt === undefined,
    };
  }

  /** Finished contests, most recent first. */
  history(): Contest[] {
    return this.storage.get<Contest[]>(HISTORY_KEY, []);
  }

  async clearHistory(): Promise<void> {
    await this.storage.update(HISTORY_KEY, []);
    this.changed.fire(this.current);
  }

  private async pool(options: StartContestOptions): Promise<Candidate<ProblemSummary>[]> {
    const index = await this.repository.getIndex(options.judge);
    if (!index) {
      return [];
    }
    const wanted = new Set(options.topics);
    const problems = index.categories
      .filter((category) => wanted.size === 0 || wanted.has(category.name))
      .flatMap((category) => category.problems);

    return this.candidatesFor(problems, options.judge, options.includeSolved ?? false);
  }

  private candidatesFor(
    problems: readonly ProblemSummary[],
    judge: JudgeId,
    includeSolved: boolean,
  ): Candidate<ProblemSummary>[] {
    const candidates: Candidate<ProblemSummary>[] = [];
    for (const problem of problems) {
      // Older caches predate the judge field; stamp it so keys stay stable.
      const stamped = { ...problem, judge: problem.judge ?? judge };
      const key = this.progress.keyOf(stamped);
      const status = this.progress.statusOf(key);
      const revisit = this.progress.isMarkedForRevision(key);

      // A solved problem still belongs in the pool when it is flagged to revise.
      if (!includeSolved && status === ProblemStatus.Solved && !revisit) {
        continue;
      }
      candidates.push({
        item: stamped,
        state: { status, attempts: this.progress.attemptsOf(key), revisit },
      });
    }
    return candidates;
  }

  /** Re-reads solve state for every contest problem. */
  private async syncSolved(): Promise<void> {
    const contest = this.current;
    if (!contest || contest.endedAt !== undefined) {
      return;
    }

    let changed = false;
    for (const problem of contest.problems) {
      const solved = this.progress.statusOf(problem.key) === ProblemStatus.Solved;
      if (solved && problem.solvedAt === undefined) {
        problem.solvedAt = Date.now();
        changed = true;
      } else if (!solved && problem.solvedAt !== undefined) {
        // A reset or a corrected sync can take a solve back.
        delete problem.solvedAt;
        changed = true;
      }
    }
    if (!changed) {
      return;
    }

    await this.persist();
    this.changed.fire(contest);

    if (contest.problems.every((problem) => problem.solvedAt !== undefined)) {
      await this.finish('finished');
    }
  }

  /** Closes out the current contest and files it in the history. */
  private async finish(reason: ContestEndReason, endedAt = Date.now()): Promise<Contest> {
    const contest = this.current;
    if (!contest) {
      throw new Error('No contest is running.');
    }
    this.stopClock();
    contest.endedAt = endedAt;
    contest.endReason = reason;

    const history = [contest, ...this.history().filter((entry) => entry.id !== contest.id)];
    await this.storage.update(HISTORY_KEY, history.slice(0, HISTORY_LIMIT));
    await this.storage.update(ACTIVE_KEY, undefined);

    this.log.info(
      `Contest ${contest.id} ended (${reason}): ` +
        `${solvedCount(contest)}/${contest.problems.length} solved`,
    );
    // Kept as `current` so the view can show the recap; `restore` drops it.
    this.changed.fire(contest);
    return contest;
  }

  private startClock(): void {
    this.stopClock();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  private stopClock(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || !snapshot.running) {
      this.stopClock();
      return;
    }
    if (snapshot.remainingMs <= 0) {
      await this.finish('timeout');
      return;
    }
    this.ticked.fire(snapshot);
  }

  private async persist(): Promise<void> {
    await this.storage.update(ACTIVE_KEY, this.current);
  }

  dispose(): void {
    this.stopClock();
    this.changed.dispose();
    this.ticked.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Resolves a contest problem back to a summary the open flow can take. */
export async function resolveContestProblem(
  repository: ProblemRepository,
  problem: ContestProblem,
): Promise<ProblemSummary> {
  const judge = problem.judge ?? DEFAULT_JUDGE;
  const found = await repository.findSummary(judge, problem.id);
  return (
    found ?? {
      judge,
      id: problem.id,
      title: problem.title,
      category: problem.category,
      url: problem.url,
    }
  );
}
