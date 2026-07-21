import type { ProblemSummary } from './problem';

/** A section of the CSES problem set, in the order the site lists them. */
export interface Category {
  readonly name: string;
  readonly problems: readonly ProblemSummary[];
}

/** The cached index: every category with its problems, plus scrape metadata. */
export interface ProblemIndex {
  readonly categories: readonly Category[];
  readonly fetchedAt: number;
  /** Schema version, bumped when the cache layout changes incompatibly. */
  readonly version: number;
}

export const INDEX_VERSION = 1;

export function countProblems(index: ProblemIndex): number {
  return index.categories.reduce((total, category) => total + category.problems.length, 0);
}
