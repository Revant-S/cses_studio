export type DiffLineType = 'added' | 'removed' | 'context';

export interface DiffLine {
  readonly type: DiffLineType;
  readonly text: string;
}

export interface ComparisonOptions {
  /** Ignore trailing whitespace on each line and trailing blank lines. */
  readonly trimTrailingWhitespace: boolean;
}

/** Normalizes program output for comparison. */
export function normalizeOutput(text: string, options: ComparisonOptions): string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const normalized = options.trimTrailingWhitespace
    ? lines.map((line) => line.replace(/[ \t]+$/, ''))
    : lines;

  if (options.trimTrailingWhitespace) {
    while (normalized.length > 0 && normalized[normalized.length - 1] === '') {
      normalized.pop();
    }
  }
  return normalized;
}

export function outputsMatch(
  expected: string,
  actual: string,
  options: ComparisonOptions,
): boolean {
  const a = normalizeOutput(expected, options);
  const b = normalizeOutput(actual, options);
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** Line diff between expected and actual output. */
export function diffLines(
  expected: string,
  actual: string,
  options: ComparisonOptions,
  limits: { maxLines?: number; maxContext?: number } = {},
): DiffLine[] {
  const maxLines = limits.maxLines ?? 400;
  const expectedLines = normalizeOutput(expected, options);
  const actualLines = normalizeOutput(actual, options);

  const truncated = expectedLines.length > maxLines || actualLines.length > maxLines;
  const a = expectedLines.slice(0, maxLines);
  const b = actualLines.slice(0, maxLines);

  const diff = backtrack(a, b, buildLcsTable(a, b));

  const collapsed = collapseContext(diff, limits.maxContext ?? 3);
  if (truncated) {
    collapsed.push({ type: 'context', text: '… output truncated for display …' });
  }
  return collapsed;
}

function buildLcsTable(a: readonly string[], b: readonly string[]): Uint32Array {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + (j + 1)] ?? 0);
    }
  }
  return table;
}

function backtrack(a: readonly string[], b: readonly string[], table: Uint32Array): DiffLine[] {
  const width = b.length + 1;
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ type: 'context', text: a[i] as string });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + (j + 1)] ?? 0)) {
      result.push({ type: 'removed', text: a[i] as string });
      i += 1;
    } else {
      result.push({ type: 'added', text: b[j] as string });
      j += 1;
    }
  }
  while (i < a.length) {
    result.push({ type: 'removed', text: a[i] as string });
    i += 1;
  }
  while (j < b.length) {
    result.push({ type: 'added', text: b[j] as string });
    j += 1;
  }
  return result;
}

function collapseContext(diff: readonly DiffLine[], maxContext: number): DiffLine[] {
  const keep = new Array<boolean>(diff.length).fill(false);

  diff.forEach((line, index) => {
    if (line.type === 'context') {
      return;
    }
    const from = Math.max(0, index - maxContext);
    const to = Math.min(diff.length - 1, index + maxContext);
    for (let i = from; i <= to; i += 1) {
      keep[i] = true;
    }
  });

  if (keep.every((value) => !value)) {
    return [];
  }

  const result: DiffLine[] = [];
  let skipping = false;
  diff.forEach((line, index) => {
    if (keep[index]) {
      result.push(line);
      skipping = false;
    } else if (!skipping) {
      result.push({ type: 'context', text: '…' });
      skipping = true;
    }
  });
  return result;
}

export function firstDifference(
  expected: string,
  actual: string,
  options: ComparisonOptions,
): { line: number; expected: string; actual: string } | undefined {
  const a = normalizeOutput(expected, options);
  const b = normalizeOutput(actual, options);
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) {
      return { line: i + 1, expected: a[i] ?? '(no line)', actual: b[i] ?? '(no line)' };
    }
  }
  return undefined;
}
