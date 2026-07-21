/** Sites this extension can browse. */
export type JudgeId = 'cses' | 'atcoder-dp';

export interface JudgeDescriptor {
  readonly id: JudgeId;
  readonly name: string;
  /** Short label for the judge switcher. */
  readonly shortName: string;
  readonly homepage: string;
  /** True when the judge supports submitting from the extension. */
  readonly canSubmit: boolean;
  /** True when solved status can be synced from an account. */
  readonly canSyncProgress: boolean;
}

export const JUDGES: Readonly<Record<JudgeId, JudgeDescriptor>> = {
  cses: {
    id: 'cses',
    name: 'CSES Problem Set',
    shortName: 'CSES',
    homepage: 'https://cses.fi/problemset/',
    canSubmit: true,
    canSyncProgress: true,
  },
  'atcoder-dp': {
    id: 'atcoder-dp',
    name: 'AtCoder Educational DP Contest',
    shortName: 'AtCoder DP',
    homepage: 'https://atcoder.jp/contests/dp',
    canSubmit: true,
    canSyncProgress: true,
  },
};

export const DEFAULT_JUDGE: JudgeId = 'cses';

export function isJudgeId(value: string): value is JudgeId {
  return value in JUDGES;
}

export function judgeOf(value: string | undefined): JudgeId {
  return value && isJudgeId(value) ? value : DEFAULT_JUDGE;
}

/** Storage key for a problem, unique across judges. */
export function problemKey(judge: JudgeId, id: string): string {
  return judge === DEFAULT_JUDGE ? id : `${judge}:${id}`;
}

/** Splits a storage key back into its judge and native id. */
export function parseProblemKey(key: string): { judge: JudgeId; id: string } {
  const separator = key.indexOf(':');
  if (separator > 0) {
    const candidate = key.slice(0, separator);
    if (isJudgeId(candidate)) {
      return { judge: candidate, id: key.slice(separator + 1) };
    }
  }
  return { judge: DEFAULT_JUDGE, id: key };
}
