import { describeFormat } from "./format";
import { decomposeComplement, tryGenerateMatchings } from "./matching";
import { makeShuffler, pairKey, type Shuffler } from "./pair";
import type {
  FormatProperties,
  Matching,
  Pair,
  PairKey,
  RivalryPin,
  RivalryPlacement,
  ScheduleConfig,
  ScheduleResult,
} from "./types";

type ResolvedPins = {
  doubleSlotMustInclude: Array<Array<Pair>>;
  singleSlotMustInclude: Array<Array<Pair>>;
  forcedDoubledPairs: Set<PairKey>;
  forcedSinglePairs: Set<PairKey>;
  doublePinnedSlots: Set<number>;
  singlePinnedSlots: Set<number>;
  placements: RivalryPlacement[];
};

export function buildSchedule(config: ScheduleConfig): ScheduleResult {
  const { teamCount, weekCount } = config;
  const hardAvoid = config.hardAvoid ?? new Set<PairKey>();
  const softAvoid = config.softAvoid ?? new Set<PairKey>();
  const rivalryPins = config.rivalryPins ?? [];
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

  const resolved = resolvePins(rivalryPins, format);
  if ("error" in resolved) {
    return {
      ok: false,
      reason: "generation-failed",
      message: resolved.error,
    };
  }

  const {
    doubleSlotMustInclude,
    singleSlotMustInclude,
    forcedDoubledPairs,
    forcedSinglePairs,
    doublePinnedSlots,
    singlePinnedSlots,
    placements,
  } = resolved;

  // Pin overrides avoid: drop forced doubled pairs from the avoid sets.
  const effectiveHardAvoid = subtract(hardAvoid, forcedDoubledPairs);
  const effectiveSoftAvoid = subtract(softAvoid, forcedDoubledPairs);
  const hasPins = rivalryPins.length > 0;
  const pinFailMessage =
    "Can't generate a schedule with these constraints. Try removing some rivalry pins.";

  // Tier 1: avoid both hard and soft up front. Forced singles must not be doubled either.
  const tier1Avoid = new Set<PairKey>([
    ...effectiveHardAvoid,
    ...effectiveSoftAvoid,
    ...forcedSinglePairs,
  ]);
  let doubleMatchings = tryGenerateMatchings(
    teamCount,
    doublesPerTeam,
    tier1Avoid,
    null,
    shuffle,
    150,
    doubleSlotMustInclude,
  );
  let clean = true;

  // Tier 2: respect hard, deprioritize (but allow) soft. Forced singles still excluded.
  if (!doubleMatchings) {
    const tier2Avoid = new Set<PairKey>([...effectiveHardAvoid, ...forcedSinglePairs]);
    doubleMatchings = tryGenerateMatchings(
      teamCount,
      doublesPerTeam,
      tier2Avoid,
      effectiveSoftAvoid,
      shuffle,
      150,
      doubleSlotMustInclude,
    );
    clean = false;
  }

  if (!doubleMatchings) {
    return {
      ok: false,
      reason: "generation-failed",
      message: hasPins
        ? pinFailMessage
        : "Could not generate doubled matchings satisfying the hard-avoid constraints. " +
          "Try shrinking the hard-avoid set.",
    };
  }

  const doubledPairs = new Set<PairKey>();
  for (const m of doubleMatchings) for (const [a, b] of m) doubledPairs.add(pairKey(a, b));

  const singleMatchings = decomposeComplement(
    teamCount,
    singlesPerTeam,
    doubledPairs,
    shuffle,
    200,
    singleSlotMustInclude,
  );
  if (!singleMatchings) {
    return {
      ok: false,
      reason: "generation-failed",
      message: hasPins
        ? pinFailMessage
        : "Could not decompose the remaining single-play pairs into perfect matchings.",
    };
  }

  const weeks = arrangeWeeks(
    doubleMatchings,
    singleMatchings,
    doublePinnedSlots,
    singlePinnedSlots,
    shuffle,
  );

  const rivalryPinnedPairs = new Set<PairKey>();
  for (const p of placements) rivalryPinnedPairs.add(pairKey(p.teamA, p.teamB));

  // Pinned pairs are allowed-by-design even if they were in an avoid set, so
  // don't flag them as repeated violations.
  const softRepeated: PairKey[] = [];
  const hardRepeated: PairKey[] = [];
  for (const key of doubledPairs) {
    if (rivalryPinnedPairs.has(key)) continue;
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
    rivalryPlacements: placements,
  };
}

function subtract(a: ReadonlySet<PairKey>, b: ReadonlySet<PairKey>): Set<PairKey> {
  const out = new Set<PairKey>();
  for (const k of a) if (!b.has(k)) out.add(k);
  return out;
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

// Resolve rivalry pins into per-slot must-include lists and the placement
// record that gets reported back. The schedule lays out as
// [D_0..D_{dp-1}, S_0..S_{sp-1}, D_0..D_{dp-1}] in 0-indexed weeks, so:
//   * first-block double weeks 1..dp pin into double slots 0..dp-1
//   * last-block double weeks (wc-dp+1)..wc pin into the same double slots
//   * middle weeks (dp+1)..(wc-dp) pin into single slots 0..sp-1
// "Any week" pins prefer middle (single) slots, distributed to weeks with the
// fewest existing pins, so notable matchups spread across the season.
function resolvePins(
  pins: ReadonlyArray<RivalryPin>,
  format: FormatProperties,
): ResolvedPins | { error: string } {
  const { teamCount, weekCount, doublesPerTeam, singlesPerTeam } = format;
  const lastBlockStart = weekCount - doublesPerTeam + 1;

  const doubleSlotMustInclude: Array<Array<Pair>> = Array.from(
    { length: doublesPerTeam },
    () => [],
  );
  const singleSlotMustInclude: Array<Array<Pair>> = Array.from(
    { length: singlesPerTeam },
    () => [],
  );
  const teamsInWeek = new Map<number, Set<number>>();
  const ensure = (week: number): Set<number> => {
    let s = teamsInWeek.get(week);
    if (!s) {
      s = new Set<number>();
      teamsInWeek.set(week, s);
    }
    return s;
  };
  const forcedDoubledPairs = new Set<PairKey>();
  const forcedSinglePairs = new Set<PairKey>();
  const doublePinnedSlots = new Set<number>();
  const singlePinnedSlots = new Set<number>();
  const placements: RivalryPlacement[] = [];

  const placeAtWeek = (
    teamA: number,
    teamB: number,
    week: number,
    pinnedWeek: number | null,
  ): string | null => {
    const tw = ensure(week);
    if (tw.has(teamA) || tw.has(teamB)) {
      return "Can't generate a schedule with these constraints. Try removing some rivalry pins.";
    }
    tw.add(teamA);
    tw.add(teamB);
    const pair: Pair = [Math.min(teamA, teamB), Math.max(teamA, teamB)];
    const key = pairKey(teamA, teamB);
    if (week <= doublesPerTeam) {
      const slot = week - 1;
      doubleSlotMustInclude[slot]!.push(pair);
      doublePinnedSlots.add(slot);
      forcedDoubledPairs.add(key);
    } else if (week >= lastBlockStart) {
      const slot = week - lastBlockStart;
      doubleSlotMustInclude[slot]!.push(pair);
      doublePinnedSlots.add(slot);
      forcedDoubledPairs.add(key);
    } else {
      const slot = week - doublesPerTeam - 1;
      singleSlotMustInclude[slot]!.push(pair);
      singlePinnedSlots.add(slot);
      forcedSinglePairs.add(key);
    }
    placements.push({ teamA, teamB, pinnedWeek, placedWeek: week });
    return null;
  };

  for (const pin of pins) {
    if (!isValidTeamPair(pin, teamCount)) {
      return { error: "Invalid rivalry pin: team indices out of range or identical." };
    }
    if (pin.week !== null) {
      if (!Number.isInteger(pin.week) || pin.week < 1 || pin.week > weekCount) {
        return { error: `Invalid rivalry pin week: must be between 1 and ${weekCount}.` };
      }
      const err = placeAtWeek(pin.teamA, pin.teamB, pin.week, pin.week);
      if (err) return { error: err };
    }
  }

  for (const pin of pins) {
    if (pin.week !== null) continue;
    if (!isValidTeamPair(pin, teamCount)) {
      return { error: "Invalid rivalry pin: team indices out of range or identical." };
    }
    const loadOf = (w: number): number => teamsInWeek.get(w)?.size ?? 0;
    const middleWeeks: number[] = [];
    for (let w = doublesPerTeam + 1; w <= weekCount - doublesPerTeam; w++) {
      middleWeeks.push(w);
    }
    const firstBlockWeeks: number[] = [];
    for (let w = 1; w <= doublesPerTeam; w++) firstBlockWeeks.push(w);
    middleWeeks.sort((a, b) => loadOf(a) - loadOf(b) || a - b);
    firstBlockWeeks.sort((a, b) => loadOf(a) - loadOf(b) || a - b);
    const candidates = [...middleWeeks, ...firstBlockWeeks];

    let placed = false;
    for (const w of candidates) {
      const tw = teamsInWeek.get(w);
      if (tw && (tw.has(pin.teamA) || tw.has(pin.teamB))) continue;
      const err = placeAtWeek(pin.teamA, pin.teamB, w, null);
      if (err) continue;
      placed = true;
      break;
    }
    if (!placed) {
      return {
        error: "Can't generate a schedule with these constraints. Try removing some rivalry pins.",
      };
    }
  }

  for (const key of forcedDoubledPairs) {
    if (forcedSinglePairs.has(key)) {
      return {
        error:
          "Rivalry pin conflict: the same matchup is pinned to both a doubled and a single week.",
      };
    }
  }

  return {
    doubleSlotMustInclude,
    singleSlotMustInclude,
    forcedDoubledPairs,
    forcedSinglePairs,
    doublePinnedSlots,
    singlePinnedSlots,
    placements,
  };
}

function isValidTeamPair(pin: RivalryPin, teamCount: number): boolean {
  return (
    Number.isInteger(pin.teamA) &&
    Number.isInteger(pin.teamB) &&
    pin.teamA >= 0 &&
    pin.teamA < teamCount &&
    pin.teamB >= 0 &&
    pin.teamB < teamCount &&
    pin.teamA !== pin.teamB
  );
}

// Place doubled matchings in the first and last `doublesPerTeam` weeks (in the
// same order both times), with single matchings in the middle. Each doubled
// pair therefore appears at week index w and week index w + (weekCount - doubles),
// giving the maximum possible separation of weekCount - doublesPerTeam weeks.
// Pinned slots keep their natural slot-to-week mapping so the pinned pair lands
// at the requested week; unpinned slots are shuffled among the remaining weeks
// for cosmetic variety.
function arrangeWeeks(
  doubleMatchings: Matching[],
  singleMatchings: Matching[],
  doublePinnedSlots: ReadonlySet<number>,
  singlePinnedSlots: ReadonlySet<number>,
  shuffle: Shuffler,
): Matching[] {
  const doubleOrder = orderWithPinned(doubleMatchings.length, doublePinnedSlots, shuffle);
  const singleOrder = orderWithPinned(singleMatchings.length, singlePinnedSlots, shuffle);
  const weeks: Matching[] = [];
  for (const i of doubleOrder) weeks.push(doubleMatchings[i] as Matching);
  for (const i of singleOrder) weeks.push(singleMatchings[i] as Matching);
  for (const i of doubleOrder) weeks.push(doubleMatchings[i] as Matching);
  return weeks;
}

function orderWithPinned(n: number, pinned: ReadonlySet<number>, shuffle: Shuffler): number[] {
  const order = new Array<number>(n);
  const unpinned: number[] = [];
  for (let i = 0; i < n; i++) {
    if (pinned.has(i)) order[i] = i;
    else unpinned.push(i);
  }
  const shuffled = shuffle(unpinned);
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (!pinned.has(i)) order[i] = shuffled[j++]!;
  }
  return order;
}
