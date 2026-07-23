import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nullLogger } from '../core/logger';
import { ProblemStatus } from '../models/problem';
import { AtCoderProblemsClient, mapResult } from '../services/atcoderProblemsClient';
import type { CsesClient } from '../services/csesClient';
import type { HttpResponse } from '../services/csesClient';

/** Stub client returning canned JSON pages, one per `from_second`. */
class StubClient {
  calls: string[] = [];
  constructor(private readonly pages: Record<number, unknown[]>) {}

  async get(pathname: string): Promise<HttpResponse> {
    this.calls.push(pathname);
    const from = Number(/from_second=(\d+)/.exec(pathname)?.[1] ?? 0);
    return {
      status: 200,
      url: pathname,
      body: JSON.stringify(this.pages[from] ?? []),
      headers: new Headers(),
    };
  }
}

const row = (problem: string, contest: string, result: string, at: number) => ({
  problem_id: problem,
  contest_id: contest,
  result,
  epoch_second: at,
});

function clientWith(pages: Record<number, unknown[]>): {
  service: AtCoderProblemsClient;
  stub: StubClient;
} {
  const stub = new StubClient(pages);
  const service = new AtCoderProblemsClient(stub as unknown as CsesClient, nullLogger);
  return { service, stub };
}

describe('mapResult', () => {
  it('treats AC as solved', () => {
    assert.equal(mapResult('AC'), ProblemStatus.Solved);
  });

  it('treats any other verdict as attempted', () => {
    for (const verdict of ['WA', 'TLE', 'RE', 'CE', 'MLE']) {
      assert.equal(mapResult(verdict), ProblemStatus.Attempted, verdict);
    }
  });
});

describe('AtCoderProblemsClient.fetchContestStatuses', () => {
  it('keeps only rows from the requested contest', async () => {
    const { service } = clientWith({
      0: [row('dp_a', 'dp', 'AC', 1), row('abc001_a', 'abc001', 'AC', 2)],
    });
    const result = await service.fetchContestStatuses('u', 'dp');

    assert.equal(result.get('dp_a'), ProblemStatus.Solved);
    assert.equal(result.has('abc001_a'), false);
  });

  it('maps the DP task ids the browser uses', async () => {
    const { service } = clientWith({
      0: [row('dp_a', 'dp', 'AC', 1), row('dp_z', 'dp', 'WA', 2)],
    });
    const result = await service.fetchContestStatuses('u', 'dp');

    assert.equal(result.get('dp_a'), ProblemStatus.Solved);
    assert.equal(result.get('dp_z'), ProblemStatus.Attempted);
  });

  it('never lets a later failure downgrade an accepted task', async () => {
    const { service } = clientWith({
      0: [row('dp_a', 'dp', 'AC', 1), row('dp_a', 'dp', 'WA', 5)],
    });
    const result = await service.fetchContestStatuses('u', 'dp');
    assert.equal(result.get('dp_a'), ProblemStatus.Solved);
  });

  it('stops early once every expected task is accepted', async () => {
    // A full first page (500 rows) would normally trigger a second request.
    const full = Array.from({ length: 500 }, (_, i) => row('dp_a', 'dp', 'AC', i + 1));
    const { service, stub } = clientWith({ 0: full, 501: [row('dp_b', 'dp', 'AC', 501)] });

    await service.fetchContestStatuses('u', 'dp', { expectedTasks: 1 });
    assert.equal(stub.calls.length, 1, 'should not page past a complete result');
  });

  it('follows pagination when a page is full and the goal is unmet', async () => {
    const full = Array.from({ length: 500 }, (_, i) => row('other', 'abc', 'AC', i + 1));
    const { service, stub } = clientWith({ 0: full, 501: [row('dp_a', 'dp', 'AC', 600)] });

    const result = await service.fetchContestStatuses('u', 'dp', { expectedTasks: 26 });
    assert.equal(stub.calls.length, 2, 'a full page must trigger the next');
    assert.equal(result.get('dp_a'), ProblemStatus.Solved);
  });

  it('url-encodes the username', async () => {
    const { service, stub } = clientWith({ 0: [] });
    await service.fetchContestStatuses('a b+c', 'dp');
    assert.match(stub.calls[0] ?? '', /user=a%20b%2Bc/);
  });
});
