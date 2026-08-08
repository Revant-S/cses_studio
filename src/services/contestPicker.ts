import { PICK_ORDER, type PickReason } from '../models/contest';
import { ProblemStatus } from '../models/problem';


/** Everything the picker needs to know about a problem's history. */
export interface CandidateState {
  readonly status: ProblemStatus;
  /** Recorded failures. */
  readonly attempts: number;
  readonly revisit: boolean;
}

export interface Candidate<T> {
  readonly item: T;
  readonly state: CandidateState;
}

export interface PickedCandidate<T> {
  readonly item: T;
  readonly reason: PickReason;
  readonly attempts: number;
}

/** Buckets one problem. */
export function classify(state: CandidateState): PickReason {
  if (state.revisit) {
    return 'revision';
  }
  if (state.attempts >= 2) {
    return 'struggled';
  }
  if (state.attempts === 1 || state.status === ProblemStatus.Attempted) {
    return 'attempted';
  }
  if (state.status !== ProblemStatus.Solved) {
    return 'fresh';
  }
  // Solved cleanly and never flagged: only drafted to fill an under-full set.
  return 'filler';
}

interface Ranked<T> {
  readonly item: T;
  readonly attempts: number;
  readonly roll: number;
}

/** Drafts up to `count` problems, highest-priority bucket first. */
export function pickContestProblems<T>(
  candidates: readonly Candidate<T>[],
  count: number,
  random: () => number = Math.random,
): PickedCandidate<T>[] {
  if (count <= 0) {
    return [];
  }

  const buckets: Record<PickReason, Ranked<T>[]> = {
    revision: [],
    struggled: [],
    attempted: [],
    fresh: [],
    filler: [],
  };

  for (const candidate of candidates) {
    buckets[classify(candidate.state)].push({
      item: candidate.item,
      attempts: candidate.state.attempts,
      roll: random(),
    });
  }

  const picked: PickedCandidate<T>[] = [];
  for (const reason of PICK_ORDER) {
    const bucket = buckets[reason];
    bucket.sort((a, b) => b.attempts - a.attempts || a.roll - b.roll);

    for (const entry of bucket) {
      if (picked.length >= count) {
        return picked;
      }
      picked.push({ item: entry.item, reason, attempts: entry.attempts });
    }
  }
  return picked;
}

/** How many candidates fall in each bucket, for the "what's eligible" preview. */
export function summarizeCandidates<T>(
  candidates: readonly Candidate<T>[],
): Record<PickReason, number> {
  const counts: Record<PickReason, number> = {
    revision: 0,
    struggled: 0,
    attempted: 0,
    fresh: 0,
    filler: 0,
  };
  for (const candidate of candidates) {
    counts[classify(candidate.state)] += 1;
  }
  return counts;
}
