import { pairKey } from "./pair";
import type { LookbackWindow, PairKey, SeasonHistory } from "./types";

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
): { hard: Set<PairKey>; soft: Set<PairKey> } {
  const hard = new Set<PairKey>();
  const soft = new Set<PairKey>();
  if (history.length === 0) return { hard, soft };

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
    }
  });

  for (const key of hard) soft.delete(key);
  return { hard, soft };
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
