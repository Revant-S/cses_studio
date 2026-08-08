import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contestLabel, formatDuration, remainingMs, solvedCount } from '../models/contest';
import type { Contest } from '../models/contest';
import { ProblemStatus } from '../models/problem';
import {
  type Candidate,
  classify,
  pickContestProblems,
  summarizeCandidates,
} from '../services/contestPicker';

/** Builds a candidate named `id` with the history described by the overrides. */
function candidate(
  id: string,
  overrides: Partial<{ status: ProblemStatus; attempts: number; revisit: boolean }> = {},
): Candidate<string> {
  return {
    item: id,
    state: {
      status: overrides.status ?? ProblemStatus.Unsolved,
      attempts: overrides.attempts ?? 0,
      revisit: overrides.revisit ?? false,
    },
  };
}

/** Deterministic stand-in for Math.random, so tie-breaks are pinned. */
function sequence(values: number[]): () => number {
  let cursor = 0;
  return () => values[cursor++] ?? 0;
}

describe('classify', () => {
  it('puts a revision flag above everything else', () => {
    // Solved and clean, but flagged: the flag is the user asking to see it.
    assert.equal(
      classify({ status: ProblemStatus.Solved, attempts: 0, revisit: true }),
      'revision',
    );
  });

  it('treats two or more failures as a struggle', () => {
    assert.equal(
      classify({ status: ProblemStatus.Solved, attempts: 2, revisit: false }),
      'struggled',
    );
  });

  it('treats a single failure as a stumble', () => {
    assert.equal(
      classify({ status: ProblemStatus.Solved, attempts: 1, revisit: false }),
      'attempted',
    );
  });

  it('counts a remote-synced attempt with no local failures', () => {
    // Account sync reports Attempted without ever calling markAttempted.
    assert.equal(
      classify({ status: ProblemStatus.Attempted, attempts: 0, revisit: false }),
      'attempted',
    );
  });

  it('calls an untouched problem fresh', () => {
    assert.equal(
      classify({ status: ProblemStatus.Unsolved, attempts: 0, revisit: false }),
      'fresh',
    );
  });

  it('demotes a cleanly solved problem to filler', () => {
    assert.equal(classify({ status: ProblemStatus.Solved, attempts: 0, revisit: false }), 'filler');
  });
});

describe('pickContestProblems', () => {
  it('drains buckets in priority order', () => {
    const picked = pickContestProblems(
      [
        candidate('fresh-a'),
        candidate('solved', { status: ProblemStatus.Solved }),
        candidate('struggled', { status: ProblemStatus.Solved, attempts: 3 }),
        candidate('flagged', { revisit: true }),
        candidate('stumbled', { attempts: 1 }),
      ],
      5,
      () => 0.5,
    );

    assert.deepEqual(
      picked.map((entry) => entry.item),
      ['flagged', 'struggled', 'stumbled', 'fresh-a', 'solved'],
    );
    assert.deepEqual(
      picked.map((entry) => entry.reason),
      ['revision', 'struggled', 'attempted', 'fresh', 'filler'],
    );
  });

  it('never lets an untouched problem outrank one that fought back', () => {
    const picked = pickContestProblems(
      [
        candidate('fresh-1'),
        candidate('fresh-2'),
        candidate('fresh-3'),
        candidate('hard', { status: ProblemStatus.Solved, attempts: 4 }),
      ],
      1,
      // Rolls that would put every fresh problem ahead on a flat sort.
      sequence([0.01, 0.02, 0.03, 0.99]),
    );
    assert.deepEqual(
      picked.map((entry) => entry.item),
      ['hard'],
    );
  });

  it('orders a bucket by how much trouble each problem caused', () => {
    const picked = pickContestProblems(
      [
        candidate('twice', { attempts: 2 }),
        candidate('five-times', { attempts: 5 }),
        candidate('thrice', { attempts: 3 }),
      ],
      3,
      () => 0.5,
    );
    assert.deepEqual(
      picked.map((entry) => entry.item),
      ['five-times', 'thrice', 'twice'],
    );
  });

  it('breaks ties with the roll, so repeat contests vary', () => {
    const pool = [candidate('a'), candidate('b'), candidate('c')];
    const first = pickContestProblems(pool, 2, sequence([0.9, 0.1, 0.5]));
    const second = pickContestProblems(pool, 2, sequence([0.1, 0.9, 0.5]));

    assert.deepEqual(
      first.map((entry) => entry.item),
      ['b', 'c'],
    );
    assert.deepEqual(
      second.map((entry) => entry.item),
      ['a', 'c'],
    );
  });

  it('stops at the requested count', () => {
    const picked = pickContestProblems(
      [candidate('a'), candidate('b'), candidate('c'), candidate('d')],
      2,
    );
    assert.equal(picked.length, 2);
  });

  it('returns everything available when the pool is short', () => {
    const picked = pickContestProblems([candidate('a')], 5);
    assert.equal(picked.length, 1);
  });

  it('returns nothing for a non-positive count', () => {
    assert.deepEqual(pickContestProblems([candidate('a')], 0), []);
  });

  it('reports the attempt count that earned each pick', () => {
    const picked = pickContestProblems([candidate('hard', { attempts: 7 })], 1);
    assert.equal(picked[0]?.attempts, 7);
  });
});

describe('summarizeCandidates', () => {
  it('counts each bucket', () => {
    const counts = summarizeCandidates([
      candidate('a', { revisit: true }),
      candidate('b', { attempts: 2 }),
      candidate('c', { attempts: 2 }),
      candidate('d'),
    ]);
    assert.equal(counts.revision, 1);
    assert.equal(counts.struggled, 2);
    assert.equal(counts.fresh, 1);
    assert.equal(counts.attempted, 0);
    assert.equal(counts.filler, 0);
  });
});

describe('contest clock', () => {
  const contest = (overrides: Partial<Contest> = {}): Contest => ({
    id: 'c1',
    judge: 'cses',
    topics: [],
    startedAt: 1_000_000,
    durationMs: 90 * 60_000,
    problems: [],
    ...overrides,
  });

  it('counts down from the absolute deadline', () => {
    const running = contest();
    assert.equal(remainingMs(running, 1_000_000 + 60_000), 90 * 60_000 - 60_000);
  });

  it('never reports negative time', () => {
    assert.equal(remainingMs(contest(), 1_000_000 + 999 * 60_000), 0);
  });

  it('freezes at the moment a contest ended', () => {
    // An ended contest must not keep draining while the recap is on screen.
    const ended = contest({ endedAt: 1_000_000 + 30 * 60_000 });
    assert.equal(remainingMs(ended, Date.now()), 60 * 60_000);
  });

  it('formats under an hour as mm:ss', () => {
    assert.equal(formatDuration(5 * 60_000 + 7_000), '5:07');
  });

  it('formats an hour and over as h:mm:ss', () => {
    assert.equal(formatDuration(3600_000 + 61_000), '1:01:01');
  });

  it('clamps a negative remainder to zero', () => {
    assert.equal(formatDuration(-5000), '0:00');
  });

  it('counts only solved problems', () => {
    const scored = contest({
      problems: [
        {
          key: '1',
          judge: 'cses',
          id: '1',
          title: 'a',
          category: 'x',
          url: '',
          reason: 'fresh',
          priorAttempts: 0,
          solvedAt: 5,
        },
        {
          key: '2',
          judge: 'cses',
          id: '2',
          title: 'b',
          category: 'x',
          url: '',
          reason: 'fresh',
          priorAttempts: 0,
        },
      ],
    });
    assert.equal(solvedCount(scored), 1);
  });
});

describe('contestLabel', () => {
  it('letters problems the way judges do', () => {
    assert.equal(contestLabel(0), 'A');
    assert.equal(contestLabel(3), 'D');
  });

  it('wraps rather than running past Z', () => {
    assert.equal(contestLabel(26), 'A');
  });
});
