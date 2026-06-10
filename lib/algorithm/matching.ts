import { pairKey, type Shuffler } from "./pair";
import type { Matching, Pair, PairKey } from "./types";

// Find a single perfect matching of `n` teams using only edges in `available`.
// `softAvoid` is a deprioritization set: edges in it are tried last, so the
// matching prefers fresh pairs but will use deprioritized edges if needed.
// `mustInclude` pins specific pairs into the matching up front; the backtracking
// search then fills the remaining unpaired teams. Returns null if no perfect
// matching exists (including when must-include pairs conflict or aren't available).
function findPerfectMatching(
  n: number,
  available: ReadonlySet<PairKey>,
  softAvoid: ReadonlySet<PairKey> | null,
  shuffle: Shuffler,
  mustInclude?: ReadonlyArray<Pair> | null,
): Matching | null {
  const matching: Matching = [];
  const paired = new Set<number>();

  if (mustInclude && mustInclude.length > 0) {
    for (const [a, b] of mustInclude) {
      if (a === b) return null;
      if (paired.has(a) || paired.has(b)) return null;
      if (!available.has(pairKey(a, b))) return null;
      paired.add(a);
      paired.add(b);
      matching.push([Math.min(a, b), Math.max(a, b)]);
    }
  }

  const pickFirstUnpaired = (): number => {
    for (let i = 0; i < n; i++) {
      if (!paired.has(i)) return i;
    }
    return -1;
  };

  const backtrack = (): boolean => {
    if (paired.size === n) return true;
    const team = pickFirstUnpaired();
    let partners: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j !== team && !paired.has(j) && available.has(pairKey(team, j))) {
        partners.push(j);
      }
    }
    if (softAvoid && softAvoid.size > 0) {
      const preferred: number[] = [];
      const deprioritized: number[] = [];
      for (const j of partners) {
        if (softAvoid.has(pairKey(team, j))) deprioritized.push(j);
        else preferred.push(j);
      }
      partners = [...shuffle(preferred), ...shuffle(deprioritized)];
    } else {
      partners = shuffle(partners);
    }
    for (const p of partners) {
      paired.add(team);
      paired.add(p);
      matching.push([Math.min(team, p), Math.max(team, p)]);
      if (backtrack()) return true;
      paired.delete(team);
      paired.delete(p);
      matching.pop();
    }
    return false;
  };

  return backtrack() ? matching : null;
}

// Generate `count` edge-disjoint perfect matchings of K_n that altogether avoid
// every pair in `avoid`. Each matching contributes `n/2` pairs; the union
// covers `count * n/2` distinct pairs and forms a `count`-regular subgraph.
// `slotMustInclude[m]` pins pairs into matching `m` (pin pairs override `avoid`).
// Returns null if no such partition is found within the attempt budget.
export function tryGenerateMatchings(
  n: number,
  count: number,
  avoid: ReadonlySet<PairKey>,
  softAvoid: ReadonlySet<PairKey> | null,
  shuffle: Shuffler,
  attempts = 150,
  slotMustInclude?: ReadonlyArray<ReadonlyArray<Pair>> | null,
): Matching[] | null {
  const mustIncludeKeys = new Set<PairKey>();
  if (slotMustInclude) {
    for (const slot of slotMustInclude) {
      for (const [a, b] of slot) mustIncludeKeys.add(pairKey(a, b));
    }
  }
  const allEdges = new Set<PairKey>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const k = pairKey(i, j);
      if (mustIncludeKeys.has(k) || !avoid.has(k)) allEdges.add(k);
    }
  }
  let effectiveSoftAvoid: ReadonlySet<PairKey> | null = null;
  if (softAvoid && softAvoid.size > 0) {
    const sa = new Set<PairKey>();
    for (const k of softAvoid) if (!mustIncludeKeys.has(k)) sa.add(k);
    effectiveSoftAvoid = sa.size > 0 ? sa : null;
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    const matchings: Matching[] = [];
    const used = new Set<PairKey>();
    let ok = true;
    for (let m = 0; m < count; m++) {
      const avail = new Set<PairKey>();
      for (const e of allEdges) if (!used.has(e)) avail.add(e);
      const must = slotMustInclude?.[m] ?? null;
      const matching = findPerfectMatching(
        n,
        avail,
        effectiveSoftAvoid,
        shuffle,
        must,
      );
      if (!matching) {
        ok = false;
        break;
      }
      matchings.push(matching);
      for (const [a, b] of matching) used.add(pairKey(a, b));
    }
    if (ok) return matchings;
  }
  return null;
}

// Decompose the complement (pairs NOT in `excluded`) into `count` edge-disjoint
// perfect matchings. The complement of a `k`-regular subgraph of K_n (n even)
// is `(n-1-k)`-regular and admits a 1-factorization into `n-1-k` matchings.
// `slotMustInclude[m]` pins pairs into matching `m`; callers must ensure those
// pairs are NOT in `excluded` (otherwise the pin can't be satisfied).
export function decomposeComplement(
  n: number,
  count: number,
  excluded: ReadonlySet<PairKey>,
  shuffle: Shuffler,
  attempts = 200,
  slotMustInclude?: ReadonlyArray<ReadonlyArray<Pair>> | null,
): Matching[] | null {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remaining = new Set<PairKey>();
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const k = pairKey(i, j);
        if (!excluded.has(k)) remaining.add(k);
      }
    }
    const matchings: Matching[] = [];
    let success = true;
    for (let m = 0; m < count; m++) {
      const must = slotMustInclude?.[m] ?? null;
      const matching = findPerfectMatching(n, remaining, null, shuffle, must);
      if (!matching) {
        success = false;
        break;
      }
      matchings.push(matching);
      for (const [a, b] of matching) remaining.delete(pairKey(a, b));
    }
    if (success) return matchings;
  }
  return null;
}
