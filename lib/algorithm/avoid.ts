import { pairKey } from "./pair";
import type { LookbackWindow, PairKey, SeasonHistory } from "./types";

export type AvoidMap = {
  hard: Set<PairKey>;
  soft: Set<PairKey>;
  // For every avoided pair, the season year(s) within the lookback window that
  // produced it, in chronological order (oldest first). Keyed by resolved
  // "i-j" pair key. A pair can map to multiple years when the lookback window
  // spans more than one season in which it was doubled.
  seasons: Map<PairKey, string[]>;
};

// Translate a chronological history of seasons (oldest first) into hard- and
// soft-avoid sets for the upcoming season.
//
// `lookback.hard` seasons before the upcoming one are hard-avoid (must not be
// doubled), and the next `lookback.soft` seasons before that are soft-avoid
// (preferred but not required to skip). Older seasons are ignored entirely so
// that the rotation continues to refresh.
//
// `currentUserIds[i]` lets userid-format history entries be remapped to the
// current roster's team indices: pair keys stored as "uid1:uid2" are resolved
// to "i-j" using the current index of each user. Entries referencing users
// who are no longer in the league are dropped silently.
export function buildAvoidMap(
  history: readonly SeasonHistory[],
  currentUserIds: readonly (string | null | undefined)[] | null | undefined,
  lookback: LookbackWindow,
): AvoidMap {
  const hard = new Set<PairKey>();
  const soft = new Set<PairKey>();
  const seasons = new Map<PairKey, string[]>();
  if (history.length === 0) return { hard, soft, seasons };

  const uidToIdx: Record<string, number> = {};
  if (currentUserIds) {
    currentUserIds.forEach((uid, idx) => {
      if (uid) uidToIdx[uid] = idx;
    });
  }

  history.forEach((season, idx) => {
    const age = history.length - idx;
    if (age > lookback.hard + lookback.soft) return;

    for (const key of season.doubles ?? []) {
      const resolved = resolveKey(key, season.format, uidToIdx);
      if (resolved === null) continue;
      if (age <= lookback.hard) hard.add(resolved);
      else soft.add(resolved);
      const years = seasons.get(resolved);
      if (years) {
        if (!years.includes(season.season)) years.push(season.season);
      } else {
        seasons.set(resolved, [season.season]);
      }
    }
  });

  for (const key of hard) soft.delete(key);
  return { hard, soft, seasons };
}

function resolveKey(
  key: PairKey,
  format: SeasonHistory["format"],
  uidToIdx: Record<string, number>,
): PairKey | null {
  if (format !== "userid") return key;
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const uid1 = key.slice(0, colon);
  const uid2 = key.slice(colon + 1);
  const i1 = uidToIdx[uid1];
  const i2 = uidToIdx[uid2];
  if (i1 === undefined || i2 === undefined) return null;
  return pairKey(i1, i2);
}
