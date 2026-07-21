import type { JudgeId } from './judge';

/** Why a problem was drafted into a contest. */
export type PickReason = 'revision' | 'struggled' | 'attempted' | 'fresh' | 'filler';

/** Priority order the picker walks. */
export const PICK_ORDER: readonly PickReason[] = [
  'revision',
  'struggled',
  'attempted',
  'fresh',
  'filler',
];

export const REASON_LABELS: Readonly<Record<PickReason, string>> = {
  revision: 'marked to revise',
  struggled: 'took several tries',
  attempted: 'stumbled once',
  fresh: 'new',
  filler: 'replay',
};

/** One drafted problem, denormalised so a contest survives a cache wipe. */
export interface ContestProblem {
  /** Progress storage key. */
  readonly key: string;
  readonly judge: JudgeId;
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly url: string;
  readonly reason: PickReason;
  /** Attempt count at draft time, kept so the recap can explain the pick. */
  readonly priorAttempts: number;
  /** Epoch millis when it was first opened during the contest. */
  openedAt?: number;
  /** Epoch millis when it turned solved during the contest. */
  solvedAt?: number;
}

export type ContestEndReason = 'finished' | 'timeout' | 'abandoned';

export interface Contest {
  readonly id: string;
  readonly judge: JudgeId;
  /** Category names the problems were drawn from. */
  readonly topics: readonly string[];
  readonly startedAt: number;
  readonly durationMs: number;
  readonly problems: ContestProblem[];
  endedAt?: number;
  endReason?: ContestEndReason;
}

/** Live view of a contest, recomputed rather than stored. */
export interface ContestSnapshot {
  readonly contest: Contest;
  readonly remainingMs: number;
  readonly elapsedMs: number;
  readonly solved: number;
  readonly total: number;
  readonly running: boolean;
}

export const MIN_CONTEST_PROBLEMS = 1;
export const MAX_CONTEST_PROBLEMS = 12;
export const MIN_CONTEST_MINUTES = 5;
export const MAX_CONTEST_MINUTES = 600;

/** Contest label for a position, mirroring how judges letter their tasks. */
export function contestLabel(position: number): string {
  return String.fromCharCode(65 + (position % 26));
}

export function remainingMs(contest: Contest, now = Date.now()): number {
  const end = contest.startedAt + contest.durationMs;
  return Math.max(0, end - (contest.endedAt ?? now));
}

export function elapsedMs(contest: Contest, now = Date.now()): number {
  return Math.min(contest.durationMs, (contest.endedAt ?? now) - contest.startedAt);
}

export function solvedCount(contest: Contest): number {
  return contest.problems.filter((problem) => problem.solvedAt !== undefined).length;
}

/** `h:mm:ss`, or `mm:ss` under an hour. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
