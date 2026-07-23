import type { Logger } from '../core/logger';
import { ProblemStatus } from '../models/problem';
import type { CsesClient } from './csesClient';

export const ATCODER_PROBLEMS_ORIGIN = 'https://kenkoooo.com';

/** One row of the AtCoder Problems submissions API. */
interface ApiSubmission {
  readonly problem_id: string;
  readonly contest_id: string;
  readonly result: string;
  readonly epoch_second: number;
}

/** AtCoder Problems returns at most this many rows per page. */
const PAGE_SIZE = 500;
/** The API asks for ≥1s between calls; keep a margin. */
const REQUEST_INTERVAL_MS = 1500;
/** Bound on pages walked so a huge submission history cannot loop forever. */
const DEFAULT_MAX_PAGES = 40;

export interface SyncProgressCallback {
  (scanned: number): void;
}

export class AtCoderProblemsClient {
  private readonly log: Logger;
  private lastRequestAt = 0;

  constructor(
    private readonly client: CsesClient,
    logger: Logger,
  ) {
    this.log = logger.scoped('atcoder-problems');
  }

  async fetchContestStatuses(
    user: string,
    contestId: string,
    options: {
      expectedTasks?: number;
      maxPages?: number;
      signal?: AbortSignal;
      onProgress?: SyncProgressCallback;
    } = {},
  ): Promise<Map<string, ProblemStatus>> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const statuses = new Map<string, ProblemStatus>();
    const acceptedTasks = new Set<string>();

    let fromSecond = 0;
    let scanned = 0;

    for (let page = 0; page < maxPages; page += 1) {
      if (options.signal?.aborted) {
        break;
      }
      await this.throttle(options.signal);

      const rows = await this.fetchPage(user, fromSecond, options.signal);
      if (rows.length === 0) {
        break;
      }
      scanned += rows.length;
      options.onProgress?.(scanned);

      for (const row of rows) {
        if (row.contest_id !== contestId) {
          continue;
        }
        const status = mapResult(row.result);
        if (status === ProblemStatus.Solved) {
          acceptedTasks.add(row.problem_id);
        }
        // Never downgrade a solved task because of an earlier failed attempt.
        if (statuses.get(row.problem_id) !== ProblemStatus.Solved) {
          statuses.set(row.problem_id, status);
        }
      }

      if (options.expectedTasks && acceptedTasks.size >= options.expectedTasks) {
        this.log.info(`All ${options.expectedTasks} ${contestId} tasks accepted; stopping early`);
        break;
      }

      // The page is time-ordered ascending; advance past its last row.
      const lastRow = rows[rows.length - 1];
      if (!lastRow || rows.length < PAGE_SIZE) {
        break;
      }
      fromSecond = lastRow.epoch_second + 1;
    }

    this.log.info(
      `Scanned ${scanned} submission(s); ${statuses.size} ${contestId} task(s) have a result`,
    );
    return statuses;
  }

  private async fetchPage(
    user: string,
    fromSecond: number,
    signal: AbortSignal | undefined,
  ): Promise<ApiSubmission[]> {
    const path = `/atcoder/atcoder-api/v3/user/submissions?user=${encodeURIComponent(
      user,
    )}&from_second=${fromSecond}`;

    const response = await this.client.get(path, { ...(signal ? { signal } : {}) });
    if (response.status !== 200) {
      throw new Error(`AtCoder Problems API returned HTTP ${response.status}`);
    }

    try {
      const parsed = JSON.parse(response.body) as unknown;
      return Array.isArray(parsed) ? (parsed as ApiSubmission[]) : [];
    } catch (error) {
      throw new Error(`AtCoder Problems API returned invalid JSON: ${String(error)}`);
    }
  }

  /** Enforces the API's "sleep ≥1s between accesses" request. */
  private async throttle(signal: AbortSignal | undefined): Promise<void> {
    const wait = this.lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) {
      await delay(wait, signal);
    }
    this.lastRequestAt = Date.now();
  }
}

/** Maps an AtCoder verdict string to a solve state. */
export function mapResult(result: string): ProblemStatus {
  return result.trim().toUpperCase() === 'AC' ? ProblemStatus.Solved : ProblemStatus.Attempted;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
