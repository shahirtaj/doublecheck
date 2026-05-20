import { describeFormat } from "./format";
import { decomposeComplement, tryGenerateMatchings } from "./matching";
import { makeShuffler, pairKey } from "./pair";
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

type SlotAssignment = {
  doubleSlotMustInclude: Array<Array<Pair>>;
  singleSlotMustInclude: Array<Array<Pair>>;
  doubleSlotWeeks: Array<[number, number]>;
  singleSlotWeeks: Array<number>;
  forcedDoubledPairs: Set<PairKey>;
  forcedSinglePairs: Set<PairKey>;
  placements: RivalryPlacement[];
};

const PIN_FAIL_MESSAGE =
  "Can't generate a schedule with these constraints. Try removing some rivalry pins.";

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
    return { ok: false, reason: "generation-failed", message: resolved.error };
  }

  const {
    doubleSlotMustInclude,
    singleSlotMustInclude,
    doubleSlotWeeks,
    singleSlotWeeks,
    forcedDoubledPairs,
    forcedSinglePairs,
    placements,
  } = resolved;

  // Pin overrides avoid: 2-pin pairs (forced doubles) take precedence over any
  // hard/soft avoidance for that pair.
  const effectiveHardAvoid = subtract(hardAvoid, forcedDoubledPairs);
  const effectiveSoftAvoid = subtract(softAvoid, forcedDoubledPairs);
  const hasPins = rivalryPins.length > 0;

  // Tier 1: avoid hard and soft up front. Forced singles must not be doubled.
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
        ? PIN_FAIL_MESSAGE
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
        ? PIN_FAIL_MESSAGE
        : "Could not decompose the remaining single-play pairs into perfect matchings.",
    };
  }

  const weeks = arrangeWeeks(
    doubleMatchings,
    singleMatchings,
    doubleSlotWeeks,
    singleSlotWeeks,
    weekCount,
  );

  const rivalryPinnedPairs = new Set<PairKey>();
  for (const p of placements) rivalryPinnedPairs.add(pairKey(p.teamA, p.teamB));

  // Pins are user-requested overrides, so don't flag them as avoidance violations.
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

// Resolve rivalry pins into per-slot must-include lists with explicit slot →
// week mappings. The model: each pin is one appearance request. Group pins by
// pair — 1 pin = the pair becomes a "forced single" (one appearance at the
// pinned week), 2 pins = a "forced double" (two appearances at the pinned
// weeks). Avoidance is overridden for pinned-week appearances only; the
// second appearance of a 1-pin pair is still suppressed by avoidance because
// the pair is excluded from the doubled set entirely.
function resolvePins(
  pins: ReadonlyArray<RivalryPin>,
  format: FormatProperties,
): SlotAssignment | { error: string } {
  const { teamCount, weekCount, doublesPerTeam: dp, singlesPerTeam: sp, separation } = format;

  type PinGroup = { pair: Pair; pins: RivalryPin[] };
  const groupsByPair = new Map<PairKey, PinGroup>();
  for (const pin of pins) {
    if (!isValidTeamPair(pin, teamCount)) {
      return { error: "Invalid rivalry pin: team indices out of range or identical." };
    }
    if (
      pin.week !== null &&
      (!Number.isInteger(pin.week) || pin.week < 1 || pin.week > weekCount)
    ) {
      return { error: `Invalid rivalry pin week: must be between 1 and ${weekCount}.` };
    }
    const key = pairKey(pin.teamA, pin.teamB);
    let group = groupsByPair.get(key);
    if (!group) {
      const a = Math.min(pin.teamA, pin.teamB);
      const b = Math.max(pin.teamA, pin.teamB);
      group = { pair: [a, b], pins: [] };
      groupsByPair.set(key, group);
    }
    group.pins.push(pin);
  }

  // A pair can appear at most ceil(weekCount / (teamCount - 1)) times in any
  // valid season — same cap the UI enforces. For all currently supported
  // formats this is 2, but compute it from the format so the limit tracks.
  const maxPinsPerPair = Math.ceil(weekCount / (teamCount - 1));
  for (const [, group] of groupsByPair) {
    if (group.pins.length > maxPinsPerPair) return { error: PIN_FAIL_MESSAGE };
    if (group.pins.length === 2) {
      const [p1, p2] = group.pins as [RivalryPin, RivalryPin];
      if (p1.week !== null && p2.week !== null && p1.week === p2.week) {
        return { error: PIN_FAIL_MESSAGE };
      }
    }
  }

  const teamsInWeek = new Map<number, Set<number>>();
  const claimWeek = (W: number, a: number, b: number): boolean => {
    let s = teamsInWeek.get(W);
    if (!s) {
      s = new Set<number>();
      teamsInWeek.set(W, s);
    }
    if (s.has(a) || s.has(b)) return false;
    s.add(a);
    s.add(b);
    return true;
  };

  const doubleSlotMustInclude: Array<Array<Pair>> = [];
  const singleSlotMustInclude: Array<Array<Pair>> = [];
  const doubleSlotWeeks: Array<[number, number]> = [];
  const singleSlotWeeks: Array<number> = [];
  const doubleSlotByWeeks = new Map<string, number>();
  const singleSlotByWeek = new Map<number, number>();

  const ensureDoubleSlot = (W1: number, W2: number): number => {
    const minW = Math.min(W1, W2);
    const maxW = Math.max(W1, W2);
    const k = `${minW}-${maxW}`;
    let idx = doubleSlotByWeeks.get(k);
    if (idx === undefined) {
      idx = doubleSlotMustInclude.length;
      doubleSlotByWeeks.set(k, idx);
      doubleSlotMustInclude.push([]);
      doubleSlotWeeks.push([minW, maxW]);
    }
    return idx;
  };
  const ensureSingleSlot = (W: number): number => {
    let idx = singleSlotByWeek.get(W);
    if (idx === undefined) {
      idx = singleSlotMustInclude.length;
      singleSlotByWeek.set(W, idx);
      singleSlotMustInclude.push([]);
      singleSlotWeeks.push(W);
    }
    return idx;
  };

  const forcedDoubledPairs = new Set<PairKey>();
  const forcedSinglePairs = new Set<PairKey>();
  const placements: RivalryPlacement[] = [];

  // Pass A: 2-pin pairs with both weeks specific. Both weeks fixed.
  for (const [key, group] of groupsByPair) {
    if (group.pins.length !== 2) continue;
    const [p1, p2] = group.pins as [RivalryPin, RivalryPin];
    if (p1.week === null || p2.week === null) continue;
    const W1 = p1.week;
    const W2 = p2.week;
    const [a, b] = group.pair;
    if (!claimWeek(W1, a, b) || !claimWeek(W2, a, b)) return { error: PIN_FAIL_MESSAGE };
    const slot = ensureDoubleSlot(W1, W2);
    doubleSlotMustInclude[slot]!.push(group.pair);
    forcedDoubledPairs.add(key);
    placements.push({ teamA: a, teamB: b, pinnedWeek: W1, placedWeek: W1 });
    placements.push({ teamA: a, teamB: b, pinnedWeek: W2, placedWeek: W2 });
  }

  // Pass B: 1-pin pairs with specific week. Forced single at that week.
  for (const [key, group] of groupsByPair) {
    if (group.pins.length !== 1) continue;
    const [p] = group.pins as [RivalryPin];
    if (p.week === null) continue;
    const [a, b] = group.pair;
    if (!claimWeek(p.week, a, b)) return { error: PIN_FAIL_MESSAGE };
    const slot = ensureSingleSlot(p.week);
    singleSlotMustInclude[slot]!.push(group.pair);
    forcedSinglePairs.add(key);
    placements.push({ teamA: a, teamB: b, pinnedWeek: p.week, placedWeek: p.week });
  }

  // Pass C: 2-pin pairs with at least one any-week. Pick remaining week(s).
  for (const [key, group] of groupsByPair) {
    if (group.pins.length !== 2) continue;
    const [p1, p2] = group.pins as [RivalryPin, RivalryPin];
    if (p1.week !== null && p2.week !== null) continue;

    const [a, b] = group.pair;
    let W1: number | null = null;
    let W2: number | null = null;
    let pinnedW1: number | null = null;
    let pinnedW2: number | null = null;

    if (p1.week !== null) {
      W1 = p1.week;
      pinnedW1 = p1.week;
    } else if (p2.week !== null) {
      W1 = p2.week;
      pinnedW1 = p2.week;
    }
    if (W1 !== null && !claimWeek(W1, a, b)) return { error: PIN_FAIL_MESSAGE };

    const candidates = enumerateCandidateWeeks(
      a,
      b,
      W1,
      teamsInWeek,
      weekCount,
      dp,
      separation,
      "double",
    );
    let placed = false;
    for (const W of candidates) {
      if (W1 !== null && W === W1) continue;
      if (claimWeek(W, a, b)) {
        W2 = W;
        placed = true;
        break;
      }
    }
    if (!placed) return { error: PIN_FAIL_MESSAGE };

    if (W1 === null) {
      // Both pins were "any" — pick a first week before W2.
      const w1Candidates = enumerateCandidateWeeks(
        a,
        b,
        W2,
        teamsInWeek,
        weekCount,
        dp,
        separation,
        "double",
      );
      let firstPlaced = false;
      for (const W of w1Candidates) {
        if (W === W2) continue;
        if (claimWeek(W, a, b)) {
          W1 = W;
          firstPlaced = true;
          break;
        }
      }
      if (!firstPlaced) return { error: PIN_FAIL_MESSAGE };
    }

    const slot = ensureDoubleSlot(W1!, W2!);
    doubleSlotMustInclude[slot]!.push(group.pair);
    forcedDoubledPairs.add(key);
    const earliest = Math.min(W1!, W2!);
    const latest = Math.max(W1!, W2!);
    const earliestPinned = W1! < W2! ? pinnedW1 : pinnedW2;
    const latestPinned = W1! < W2! ? pinnedW2 : pinnedW1;
    placements.push({ teamA: a, teamB: b, pinnedWeek: earliestPinned, placedWeek: earliest });
    placements.push({ teamA: a, teamB: b, pinnedWeek: latestPinned, placedWeek: latest });
  }

  // Pass D: 1-pin pairs with any-week. Pick a single-slot week.
  for (const [key, group] of groupsByPair) {
    if (group.pins.length !== 1) continue;
    const [p] = group.pins as [RivalryPin];
    if (p.week !== null) continue;
    const [a, b] = group.pair;
    const candidates = enumerateCandidateWeeks(
      a,
      b,
      null,
      teamsInWeek,
      weekCount,
      dp,
      separation,
      "single",
    );
    let placed = false;
    for (const W of candidates) {
      if (claimWeek(W, a, b)) {
        const slot = ensureSingleSlot(W);
        singleSlotMustInclude[slot]!.push(group.pair);
        forcedSinglePairs.add(key);
        placements.push({ teamA: a, teamB: b, pinnedWeek: null, placedWeek: W });
        placed = true;
        break;
      }
    }
    if (!placed) return { error: PIN_FAIL_MESSAGE };
  }

  if (doubleSlotMustInclude.length > dp) return { error: PIN_FAIL_MESSAGE };
  if (singleSlotMustInclude.length > sp) return { error: PIN_FAIL_MESSAGE };

  // Fill remaining slots with unpinned doubles/singles. Strategy: take all
  // unused weeks in sorted order; the first remDouble pair up with the last
  // remDouble (giving the default block structure when no pins are present);
  // the middle weeks become unpinned singles.
  const usedWeeks = new Set<number>();
  for (const [W1, W2] of doubleSlotWeeks) {
    usedWeeks.add(W1);
    usedWeeks.add(W2);
  }
  for (const W of singleSlotWeeks) usedWeeks.add(W);

  const remainingWeeks: number[] = [];
  for (let W = 1; W <= weekCount; W++) {
    if (!usedWeeks.has(W)) remainingWeeks.push(W);
  }

  const remDouble = dp - doubleSlotMustInclude.length;
  const remSingle = sp - singleSlotMustInclude.length;
  if (remDouble < 0 || remSingle < 0) return { error: PIN_FAIL_MESSAGE };
  if (2 * remDouble + remSingle !== remainingWeeks.length) {
    return { error: PIN_FAIL_MESSAGE };
  }

  for (let i = 0; i < remDouble; i++) {
    const W1 = remainingWeeks[i]!;
    const W2 = remainingWeeks[remainingWeeks.length - remDouble + i]!;
    doubleSlotMustInclude.push([]);
    doubleSlotWeeks.push([W1, W2]);
  }
  for (let i = remDouble; i < remainingWeeks.length - remDouble; i++) {
    singleSlotMustInclude.push([]);
    singleSlotWeeks.push(remainingWeeks[i]!);
  }

  return {
    doubleSlotMustInclude,
    singleSlotMustInclude,
    doubleSlotWeeks,
    singleSlotWeeks,
    forcedDoubledPairs,
    forcedSinglePairs,
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

// Ordered list of candidate weeks for an any-week pin, biased to keep the
// default block structure intact. dp is doublesPerTeam; weeks in (dp, wc-dp]
// (1-indexed) are the natural "middle" / single-slot zone.
// - kind === "single": prefer middle weeks (least-loaded first), then ends.
// - kind === "double" with partnerWeek: prefer partnerWeek ± separation,
//   which matches the default block pairing; then any other week.
// - kind === "double" without partnerWeek: prefer block-end weeks.
function enumerateCandidateWeeks(
  _teamA: number,
  _teamB: number,
  partnerWeek: number | null,
  teamsInWeek: ReadonlyMap<number, ReadonlySet<number>>,
  weekCount: number,
  doublesPerTeam: number,
  separation: number,
  kind: "single" | "double",
): number[] {
  const loadOf = (W: number): number => teamsInWeek.get(W)?.size ?? 0;
  const allWeeks: number[] = [];
  for (let W = 1; W <= weekCount; W++) allWeeks.push(W);

  if (kind === "double" && partnerWeek !== null) {
    const preferred = [partnerWeek + separation, partnerWeek - separation].filter(
      (W) => W >= 1 && W <= weekCount,
    );
    const others = allWeeks.filter((W) => !preferred.includes(W));
    others.sort((a, b) => loadOf(a) - loadOf(b) || a - b);
    return [...preferred, ...others];
  }

  const middle: number[] = [];
  const ends: number[] = [];
  for (const W of allWeeks) {
    if (W > doublesPerTeam && W <= weekCount - doublesPerTeam) middle.push(W);
    else ends.push(W);
  }
  middle.sort((a, b) => loadOf(a) - loadOf(b) || a - b);
  ends.sort((a, b) => loadOf(a) - loadOf(b) || a - b);
  return kind === "single" ? [...middle, ...ends] : [...ends, ...middle];
}

// Place each generated matching at its assigned week(s). doubleSlotWeeks[i] is
// the [first, second] week pair where doubleMatchings[i] appears (both weeks
// contain the same matching). singleSlotWeeks[j] is the lone week for
// singleMatchings[j].
function arrangeWeeks(
  doubleMatchings: Matching[],
  singleMatchings: Matching[],
  doubleSlotWeeks: ReadonlyArray<readonly [number, number]>,
  singleSlotWeeks: ReadonlyArray<number>,
  weekCount: number,
): Matching[] {
  const weeks: (Matching | null)[] = new Array(weekCount).fill(null);
  for (let i = 0; i < doubleMatchings.length; i++) {
    const [W1, W2] = doubleSlotWeeks[i]!;
    const m = doubleMatchings[i] as Matching;
    weeks[W1 - 1] = m;
    weeks[W2 - 1] = m;
  }
  for (let i = 0; i < singleMatchings.length; i++) {
    const W = singleSlotWeeks[i]!;
    weeks[W - 1] = singleMatchings[i] as Matching;
  }
  return weeks as Matching[];
}
