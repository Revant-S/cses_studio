/** Judge verdicts CSES can report for a submission. */
export enum Verdict {
  Accepted = 'ACCEPTED',
  WrongAnswer = 'WRONG ANSWER',
  TimeLimitExceeded = 'TIME LIMIT EXCEEDED',
  RuntimeError = 'RUNTIME ERROR',
  CompileError = 'COMPILE ERROR',
  MemoryLimitExceeded = 'MEMORY LIMIT EXCEEDED',
  Pending = 'PENDING',
  Unknown = 'UNKNOWN',
}

/** Result of a single judge test, as listed on the submission result page. */
export interface TestResult {
  readonly test: number;
  readonly verdict: Verdict;
  readonly time?: string;
  /** Link to the per-test detail page, when the result page offers one. */
  readonly detailUrl?: string;
  /** Test data scraped from the detail page. */
  readonly input?: string;
  readonly expectedOutput?: string;
  readonly actualOutput?: string;
  readonly truncated?: boolean;
}

export function isFailed(test: TestResult): boolean {
  return test.verdict !== Verdict.Accepted;
}

export interface SubmissionResult {
  readonly submissionId: string;
  readonly url: string;
  readonly verdict: Verdict;
  /** Raw verdict text, retained when it does not map onto a known enum member. */
  readonly rawVerdict: string;
  readonly time?: string;
  readonly memory?: string;
  readonly compilerOutput?: string;
  readonly tests: readonly TestResult[];
}

const VERDICT_PATTERNS: ReadonlyArray<readonly [RegExp, Verdict]> = [
  [/accepted/i, Verdict.Accepted],
  [/wrong\s*answer/i, Verdict.WrongAnswer],
  [/time\s*limit/i, Verdict.TimeLimitExceeded],
  [/memory\s*limit/i, Verdict.MemoryLimitExceeded],
  [/compil(e|ation)\s*error/i, Verdict.CompileError],
  [/runtime\s*error/i, Verdict.RuntimeError],
  [/(pending|running|testing|compiling|first test|in queue)/i, Verdict.Pending],
];

/** Maps free-form verdict text from the result page onto a {@link Verdict}. */
export function parseVerdict(text: string): Verdict {
  const normalized = text.trim();
  for (const [pattern, verdict] of VERDICT_PATTERNS) {
    if (pattern.test(normalized)) {
      return verdict;
    }
  }
  return Verdict.Unknown;
}

export function isTerminal(verdict: Verdict): boolean {
  return verdict !== Verdict.Pending && verdict !== Verdict.Unknown;
}
