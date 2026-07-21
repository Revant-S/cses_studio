/** One example test case parsed from the problem statement. */
export interface Sample {
  /** 1-based index matching the generated `sample<N>.in` / `sample<N>.out` files. */
  readonly index: number;
  readonly input: string;
  readonly output: string;
  /** Optional explanation paragraph that followed the example on the page. */
  readonly explanation?: string;
}
