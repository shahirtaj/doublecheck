import type { PairKey } from "./types";

export function pairKey(i: number, j: number): PairKey {
  return i < j ? `${i}-${j}` : `${j}-${i}`;
}

export function unpackPairKey(key: PairKey): [number, number] {
  const dash = key.indexOf("-");
  return [Number(key.slice(0, dash)), Number(key.slice(dash + 1))];
}

export type Shuffler = <T>(arr: readonly T[]) => T[];

export function makeShuffler(random: () => number): Shuffler {
  return function shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const tmp = a[i] as T;
      a[i] = a[j] as T;
      a[j] = tmp;
    }
    return a;
  };
}
