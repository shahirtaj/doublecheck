import { pairKey, type Shuffler } from "./pair";
import type { Matching, PairKey } from "./types";

// Find a single perfect matching of `n` teams using only edges in `available`.
// `softAvoid` is a deprioritization set: edges in it are tried last, so the
// matching prefers fresh pairs but will use deprioritized edges if needed.
// Returns null if no perfect matching exists.
export function findPerfectMatching(
  n: number,
  available: ReadonlySet<PairKey>,
  softAvoid: ReadonlySet<PairKey> | null,
  shuffle: Shuffler,
): Matching | null {
  const matching: Matching = [];
  const paired = new Set<number>();

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
// Returns null if no such partition is found within the attempt budget.
export function tryGenerateMatchings(
  n: number,
  count: number,
  avoid: ReadonlySet<PairKey>,
  softAvoid: ReadonlySet<PairKey> | null,
  shuffle: Shuffler,
  attempts = 150,
): Matching[] | null {
  const allEdges = new Set<PairKey>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const k = pairKey(i, j);
      if (!avoid.has(k)) allEdges.add(k);
    }
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    const matchings: Matching[] = [];
    const used = new Set<PairKey>();
    let ok = true;
    for (let m = 0; m < count; m++) {
      const avail = new Set<PairKey>();
      for (const e of allEdges) if (!used.has(e)) avail.add(e);
      const matching = findPerfectMatching(n, avail, softAvoid, shuffle);
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
export function decomposeComplement(
  n: number,
  count: number,
  excluded: ReadonlySet<PairKey>,
  shuffle: Shuffler,
  attempts = 200,
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
      const matching = findPerfectMatching(n, remaining, null, shuffle);
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
