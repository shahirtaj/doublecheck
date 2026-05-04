import { describeFormat } from "./format";
import { decomposeComplement, tryGenerateMatchings } from "./matching";
import { makeShuffler, pairKey } from "./pair";
import type { Matching, PairKey, ScheduleConfig, ScheduleResult } from "./types";

export function buildSchedule(config: ScheduleConfig): ScheduleResult {
  const { teamCount, weekCount } = config;
  const hardAvoid = config.hardAvoid ?? new Set<PairKey>();
  const softAvoid = config.softAvoid ?? new Set<PairKey>();
  const random = config.random ?? Math.random;
  const shuffle = makeShuffler(random);

  const validation = validate(teamCount, weekCount);
  if (validation) return validation;

  const format = describeFormat(teamCount, weekCount);
  const { doublesPerTeam, singlesPerTeam } = format;

  if (doublesPerTeam === 0) {
    return {
      ok: false,
      reason: "pure-round-robin",
      message:
        `${teamCount}-team / ${weekCount}-week is a pure round-robin: every team plays every opponent exactly once. ` +
        "No fairness issue — no rotational schedule needed.",
      format,
    };
  }

  if (singlesPerTeam === 0) {
    return {
      ok: false,
      reason: "complete-double-round-robin",
      message:
        `${teamCount}-team / ${weekCount}-week is a complete double round-robin: every team plays every opponent exactly twice. ` +
        "No fairness issue — no rotational schedule needed.",
      format,
    };
  }

  // Tier 1: avoid both hard and soft sets up front.
  const allAvoid = new Set<PairKey>([...hardAvoid, ...softAvoid]);
  let doubleMatchings = tryGenerateMatchings(teamCount, doublesPerTeam, allAvoid, null, shuffle);
  let clean = true;

  // Tier 2: respect hard, deprioritize (but allow) soft.
  if (!doubleMatchings) {
    doubleMatchings = tryGenerateMatchings(teamCount, doublesPerTeam, hardAvoid, softAvoid, shuffle);
    clean = false;
  }

  if (!doubleMatchings) {
    return {
      ok: false,
      reason: "generation-failed",
      message:
        "Could not generate doubled matchings satisfying the hard-avoid constraints. " +
        "Try shrinking the hard-avoid set.",
    };
  }

  const doubledPairs = new Set<PairKey>();
  for (const m of doubleMatchings) for (const [a, b] of m) doubledPairs.add(pairKey(a, b));

  const singleMatchings = decomposeComplement(teamCount, singlesPerTeam, doubledPairs, shuffle);
  if (!singleMatchings) {
    return {
      ok: false,
      reason: "generation-failed",
      message: "Could not decompose the remaining single-play pairs into perfect matchings.",
    };
  }

  const weeks = arrangeWeeks(doubleMatchings, singleMatchings, shuffle);

  const softRepeated: PairKey[] = [];
  const hardRepeated: PairKey[] = [];
  for (const key of doubledPairs) {
    if (softAvoid.has(key)) softRepeated.push(key);
    if (hardAvoid.has(key)) hardRepeated.push(key);
  }

  return {
    ok: true,
    weeks,
    doubledPairs,
    softRepeated,
    hardRepeated,
    clean,
    format,
  };
}

function validate(teamCount: number, weekCount: number): ScheduleResult | null {
  if (!Number.isInteger(teamCount) || teamCount < 2 || teamCount % 2 !== 0) {
    return {
      ok: false,
      reason: "invalid-format",
      message: `Team count must be an even integer >= 2 (got ${teamCount}).`,
    };
  }
  if (!Number.isInteger(weekCount) || weekCount < 1) {
    return {
      ok: false,
      reason: "invalid-format",
      message: `Week count must be a positive integer (got ${weekCount}).`,
    };
  }
  if (weekCount < teamCount - 1) {
    return {
      ok: false,
      reason: "invalid-format",
      message:
        `Week count (${weekCount}) is less than the ${teamCount - 1} weeks required for a single round-robin ` +
        `with ${teamCount} teams. Incomplete round-robins are not supported.`,
    };
  }
  if (weekCount > 2 * (teamCount - 1)) {
    return {
      ok: false,
      reason: "invalid-format",
      message:
        `Week count (${weekCount}) exceeds two full round-robins (${2 * (teamCount - 1)} weeks) for ${teamCount} teams.`,
    };
  }
  return null;
}

// Place doubled matchings in the first and last `doublesPerTeam` weeks (in the
// same order both times), with single matchings in the middle. Each doubled
// pair therefore appears at week index w and week index w + (weekCount - doubles),
// giving the maximum possible separation of weekCount - doublesPerTeam weeks.
function arrangeWeeks(
  doubleMatchings: Matching[],
  singleMatchings: Matching[],
  shuffle: ReturnType<typeof makeShuffler>,
): Matching[] {
  const doubleOrder = shuffle(doubleMatchings.map((_, i) => i));
  const singleOrder = shuffle(singleMatchings.map((_, i) => i));
  const weeks: Matching[] = [];
  for (const i of doubleOrder) weeks.push(doubleMatchings[i] as Matching);
  for (const i of singleOrder) weeks.push(singleMatchings[i] as Matching);
  for (const i of doubleOrder) weeks.push(doubleMatchings[i] as Matching);
  return weeks;
}
