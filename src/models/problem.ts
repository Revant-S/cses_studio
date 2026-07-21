import type { JudgeId } from './judge';
import type { Sample } from './sample';

/** Solve state of a problem, mirrored from CSES when authenticated. */
export enum ProblemStatus {
  Unsolved = 'unsolved',
  Attempted = 'attempted',
  Solved = 'solved',
}

/** Lightweight entry produced by scraping the problem set index. */
export interface ProblemSummary {
  /** Site this problem belongs to. */
  readonly judge?: JudgeId;
  /** Site-native id, e.g. `1194` on CSES or `dp_a` on AtCoder. */
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly url: string;
  /** Solvers / attempters counts shown on the index, when present. */
  readonly solvedCount?: number;
  readonly attemptedCount?: number;
}

/** A fully scraped problem, cached on disk under `problems/<id>.json`. */
export interface Problem extends ProblemSummary {
  /** Rendered statement HTML, math preserved as `\(...\)` / `\[...\]` delimiters. */
  readonly statement: string;
  readonly input: string;
  readonly output: string;
  readonly constraints: string;
  readonly notes: string;
  /** Time limit in seconds, or undefined when the page omits it. */
  readonly timeLimit?: number;
  /** Memory limit in megabytes, or undefined when the page omits it. */
  readonly memoryLimit?: number;
  readonly samples: readonly Sample[];
  /** Epoch millis of the last successful scrape. */
  readonly fetchedAt: number;
}

export function isProblem(value: Problem | ProblemSummary): value is Problem {
  return 'statement' in value;
}
