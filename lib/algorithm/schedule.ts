import { describeFormat } from "./format";
import { decomposeComplement, tryGenerateMatchings } from "./matching";
import { makeShuffler, pairKey, unpackPairKey, type Shuffler } from "./pair";
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

  if (doublesPerTeam === 0 && rivalryPins.length === 0) {
    return {
      ok: false,
      reason: "pure-round-robin",
      message:
        `${teamCount}-team / ${weekCount}-week is a pure round-robin: every team plays every opponent exactly once. ` +
        "No fairness issue — no rotational schedule needed.",
      format,
    };
  }
  // For pure round-robin formats with rivalry pins, fall through and let the
  // generator place the pinned matchups; with dp=0 every pin is a forced
  // single and the schedule is just a constrained 1-factorization of K_n.

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

  // Detect 2-pin pairs whose weeks are not the natural double-partner pair
  // (W, W±separation). Such pins force the same matching to be at two
  // non-partner weeks under the slot-based architecture, which mirrors every
  // other pair across those two weeks. We branch to a per-week generator
  // that builds two independent matchings sharing only the pinned edge.
  if (hasNonPartnerTwoPin(rivalryPins, format)) {
    return buildScheduleWeekByWeek(
      teamCount,
      weekCount,
      format,
      hardAvoid,
      softAvoid,
      rivalryPins,
      shuffle,
    );
  }

  const resolved = resolvePins(rivalryPins, format, hardAvoid);
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
// week mappings. The model:
//   * 2 pins on a pair = forced double, both pinned weeks fixed, avoidance
//     fully overridden.
//   * 1 pin + hard-avoided pair = forced single (avoidance suppresses the
//     second appearance the schedule structure would otherwise add).
//   * 1 pin + non-hard-avoided pair = "at least one game" at the pinned
//     week. If the pinned week is one of the format's block-area weeks
//     (W <= dp or W > wc - dp), the pair naturally doubles into the
//     corresponding paired week. If that paired week is already claimed, or
//     the pinned week is in the middle, the pair stays single.
function resolvePins(
  pins: ReadonlyArray<RivalryPin>,
  format: FormatProperties,
  hardAvoid: ReadonlySet<PairKey>,
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

  const willBeForcedSingle = (pair: Pair, W: number): boolean => {
    if (hardAvoid.has(pairKey(pair[0], pair[1]))) return true;
    const inBlockArea = W <= dp || W > weekCount - dp;
    return !inBlockArea;
  };

  // Place a 1-pin pair at week W. Hard-avoided pairs stay single; non-hard-
  // avoided pairs in the block area attempt the natural double at W±sep and
  // fall back to single if that paired week is already claimed OR the week
  // already hosts a forced-single matching (mixing a doubled matching and a
  // single matching at the same week is structurally impossible).
  const place1PinAtWeek = (
    pair: Pair,
    W: number,
    pinnedWeek: number | null,
  ): boolean => {
    const [a, b] = pair;
    if (!claimWeek(W, a, b)) return false;
    const key = pairKey(a, b);
    const isHardAvoided = hardAvoid.has(key);
    const inBlockArea = W <= dp || W > weekCount - dp;
    const weekHasForcedSingle = singleSlotByWeek.has(W);
    if (!isHardAvoided && inBlockArea && !weekHasForcedSingle) {
      const W2 = W <= dp ? W + separation : W - separation;
      if (W2 >= 1 && W2 <= weekCount && claimWeek(W2, a, b)) {
        const slot = ensureDoubleSlot(W, W2);
        doubleSlotMustInclude[slot]!.push(pair);
        forcedDoubledPairs.add(key);
        placements.push({ teamA: a, teamB: b, pinnedWeek, placedWeek: W });
        return true;
      }
    }
    const slot = ensureSingleSlot(W);
    singleSlotMustInclude[slot]!.push(pair);
    forcedSinglePairs.add(key);
    placements.push({ teamA: a, teamB: b, pinnedWeek, placedWeek: W });
    return true;
  };

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

  // Pass B: 1-pin pairs with specific week. Process forced singles first so
  // tentative-double pins can see the S slot and demote themselves, avoiding
  // a structurally invalid mix of D and S matchings at the same week.
  for (const [, group] of groupsByPair) {
    if (group.pins.length !== 1) continue;
    const [p] = group.pins as [RivalryPin];
    if (p.week === null) continue;
    if (!willBeForcedSingle(group.pair, p.week)) continue;
    if (!place1PinAtWeek(group.pair, p.week, p.week)) {
      return { error: PIN_FAIL_MESSAGE };
    }
  }
  for (const [, group] of groupsByPair) {
    if (group.pins.length !== 1) continue;
    const [p] = group.pins as [RivalryPin];
    if (p.week === null) continue;
    if (willBeForcedSingle(group.pair, p.week)) continue;
    if (!place1PinAtWeek(group.pair, p.week, p.week)) {
      return { error: PIN_FAIL_MESSAGE };
    }
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

  // Pass D: 1-pin pairs with any-week. Pick a compatible week; block-aware
  // doubling falls out of place1PinAtWeek when the chosen week is at the ends.
  for (const [, group] of groupsByPair) {
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
      const tw = teamsInWeek.get(W);
      if (tw && (tw.has(a) || tw.has(b))) continue;
      if (place1PinAtWeek(group.pair, W, null)) {
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

// True if any 2-pin rivalry pair has specific weeks that aren't natural
// double partners (|W2 - W1| !== separation). The slot-based generator
// reuses one matching at both pinned weeks, which mirrors every other pair
// across those two weeks. For those cases we switch to a per-week generator
// below that produces independent matchings sharing only the pinned edge.
function hasNonPartnerTwoPin(
  pins: ReadonlyArray<RivalryPin>,
  format: FormatProperties,
): boolean {
  const { separation } = format;
  const groups = new Map<PairKey, number[]>();
  for (const pin of pins) {
    if (pin.week === null) continue;
    const k = pairKey(pin.teamA, pin.teamB);
    let list = groups.get(k);
    if (!list) {
      list = [];
      groups.set(k, list);
    }
    list.push(pin.week);
  }
  for (const [, weeks] of groups) {
    if (weeks.length !== 2) continue;
    if (Math.abs(weeks[0]! - weeks[1]!) !== separation) return true;
  }
  return false;
}

type WeeklyPinClassification = {
  forcedDoubled: Set<PairKey>;
  forcedSingle: Set<PairKey>;
  weekMustInclude: Map<number, Pair[]>;
  placements: RivalryPlacement[];
  // For each pinned week W, the set of partner weeks pinned by the same
  // 2-pin pair where (W, partner) is not a natural double partner pair. Used
  // by the per-week generator to forbid algorithm-chosen pairs at W from
  // recurring at the partner week (independence constraint).
  nonPartnerPartners: Map<number, Set<number>>;
};

function classifyPinsForWeekly(
  pins: ReadonlyArray<RivalryPin>,
  format: FormatProperties,
  hardAvoid: ReadonlySet<PairKey>,
): WeeklyPinClassification | { error: string } {
  const { teamCount, weekCount, doublesPerTeam: dp, separation } = format;
  const maxPinsPerPair = Math.ceil(weekCount / (teamCount - 1));

  type PinGroup = { pair: Pair; pins: RivalryPin[] };
  const groups = new Map<PairKey, PinGroup>();
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
    const k = pairKey(pin.teamA, pin.teamB);
    let g = groups.get(k);
    if (!g) {
      const a = Math.min(pin.teamA, pin.teamB);
      const b = Math.max(pin.teamA, pin.teamB);
      g = { pair: [a, b], pins: [] };
      groups.set(k, g);
    }
    g.pins.push(pin);
  }

  for (const [, g] of groups) {
    if (g.pins.length > maxPinsPerPair) return { error: PIN_FAIL_MESSAGE };
    if (g.pins.length === 2) {
      const [p1, p2] = g.pins as [RivalryPin, RivalryPin];
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

  const forcedDoubled = new Set<PairKey>();
  const forcedSingle = new Set<PairKey>();
  const weekMustInclude = new Map<number, Pair[]>();
  const placements: RivalryPlacement[] = [];
  const nonPartnerPartners = new Map<number, Set<number>>();

  const addMust = (W: number, pair: Pair): void => {
    let list = weekMustInclude.get(W);
    if (!list) {
      list = [];
      weekMustInclude.set(W, list);
    }
    list.push(pair);
  };
  const recordNonPartner = (w1: number, w2: number): void => {
    let s1 = nonPartnerPartners.get(w1);
    if (!s1) {
      s1 = new Set();
      nonPartnerPartners.set(w1, s1);
    }
    s1.add(w2);
    let s2 = nonPartnerPartners.get(w2);
    if (!s2) {
      s2 = new Set();
      nonPartnerPartners.set(w2, s2);
    }
    s2.add(w1);
  };

  // Pass A: 2-pin both specific.
  for (const [key, g] of groups) {
    if (g.pins.length !== 2) continue;
    const [p1, p2] = g.pins as [RivalryPin, RivalryPin];
    if (p1.week === null || p2.week === null) continue;
    const w1 = p1.week;
    const w2 = p2.week;
    const [a, b] = g.pair;
    if (!claimWeek(w1, a, b) || !claimWeek(w2, a, b)) {
      return { error: PIN_FAIL_MESSAGE };
    }
    forcedDoubled.add(key);
    addMust(w1, g.pair);
    addMust(w2, g.pair);
    placements.push({ teamA: a, teamB: b, pinnedWeek: w1, placedWeek: w1 });
    placements.push({ teamA: a, teamB: b, pinnedWeek: w2, placedWeek: w2 });
    if (Math.abs(w2 - w1) !== separation) recordNonPartner(w1, w2);
  }

  // Pass B: 1-pin specific.
  for (const [key, g] of groups) {
    if (g.pins.length !== 1) continue;
    const [p] = g.pins as [RivalryPin];
    if (p.week === null) continue;
    const [a, b] = g.pair;
    if (!claimWeek(p.week, a, b)) return { error: PIN_FAIL_MESSAGE };
    addMust(p.week, g.pair);
    placements.push({ teamA: a, teamB: b, pinnedWeek: p.week, placedWeek: p.week });
    if (hardAvoid.has(key)) forcedSingle.add(key);
  }

  // Pass C: 2-pin with any-week.
  for (const [key, g] of groups) {
    if (g.pins.length !== 2) continue;
    const [p1, p2] = g.pins as [RivalryPin, RivalryPin];
    if (p1.week !== null && p2.week !== null) continue;
    const [a, b] = g.pair;
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
      a, b, W1, teamsInWeek, weekCount, dp, separation, "double",
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
      const w1Candidates = enumerateCandidateWeeks(
        a, b, W2, teamsInWeek, weekCount, dp, separation, "double",
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

    forcedDoubled.add(key);
    addMust(W1!, g.pair);
    addMust(W2!, g.pair);
    const earliest = Math.min(W1!, W2!);
    const latest = Math.max(W1!, W2!);
    const earliestPinned = W1! < W2! ? pinnedW1 : pinnedW2;
    const latestPinned = W1! < W2! ? pinnedW2 : pinnedW1;
    placements.push({ teamA: a, teamB: b, pinnedWeek: earliestPinned, placedWeek: earliest });
    placements.push({ teamA: a, teamB: b, pinnedWeek: latestPinned, placedWeek: latest });
    if (Math.abs(W2! - W1!) !== separation) recordNonPartner(W1!, W2!);
  }

  // Pass D: 1-pin any-week.
  for (const [key, g] of groups) {
    if (g.pins.length !== 1) continue;
    const [p] = g.pins as [RivalryPin];
    if (p.week !== null) continue;
    const [a, b] = g.pair;
    const candidates = enumerateCandidateWeeks(
      a, b, null, teamsInWeek, weekCount, dp, separation, "single",
    );
    let placed = false;
    for (const W of candidates) {
      const tw = teamsInWeek.get(W);
      if (tw && (tw.has(a) || tw.has(b))) continue;
      if (claimWeek(W, a, b)) {
        addMust(W, g.pair);
        placements.push({ teamA: a, teamB: b, pinnedWeek: null, placedWeek: W });
        if (hardAvoid.has(key)) forcedSingle.add(key);
        placed = true;
        break;
      }
    }
    if (!placed) return { error: PIN_FAIL_MESSAGE };
  }

  return { forcedDoubled, forcedSingle, weekMustInclude, placements, nonPartnerPartners };
}

// Choose a `target`-sized set of pairs forming a `dp`-regular subgraph of
// K_n, including all forced doubles and excluding forced singles + hardAvoid.
// Greedy with retry — usually finds a valid set quickly for typical inputs.
function pickDoubledSet(
  n: number,
  dp: number,
  forcedDoubled: ReadonlySet<PairKey>,
  forcedSingle: ReadonlySet<PairKey>,
  hardAvoid: ReadonlySet<PairKey>,
  softAvoid: ReadonlySet<PairKey>,
  shuffle: Shuffler,
  target: number,
): Set<PairKey> | null {
  const tier1: PairKey[] = [];
  const tier2: PairKey[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const k = pairKey(i, j);
      if (forcedDoubled.has(k) || hardAvoid.has(k) || forcedSingle.has(k)) continue;
      if (softAvoid.has(k)) tier2.push(k);
      else tier1.push(k);
    }
  }

  for (let attempt = 0; attempt < 50; attempt++) {
    const doubled = new Set<PairKey>(forcedDoubled);
    const degree = new Array<number>(n).fill(0);
    for (const k of doubled) {
      const [a, b] = unpackPairKey(k);
      degree[a]!++;
      degree[b]!++;
    }
    let exceeded = false;
    for (let i = 0; i < n; i++) {
      if (degree[i]! > dp) {
        exceeded = true;
        break;
      }
    }
    if (exceeded) return null;
    if (doubled.size > target) return null;

    const ordered = [...shuffle(tier1), ...shuffle(tier2)];
    for (const k of ordered) {
      if (doubled.size === target) break;
      const [a, b] = unpackPairKey(k);
      if (degree[a]! < dp && degree[b]! < dp) {
        doubled.add(k);
        degree[a]!++;
        degree[b]!++;
      }
    }
    if (doubled.size === target) {
      // Also verify all degrees are exactly dp.
      let allDp = true;
      for (let i = 0; i < n; i++) {
        if (degree[i]! !== dp) {
          allDp = false;
          break;
        }
      }
      if (allDp) return doubled;
    }
  }
  return null;
}

// Find a perfect matching for one week. mustInclude pairs are pre-placed;
// the rest are filled by backtracking, restricted to edges with remaining
// budget > 0 and not in `excluded` (which carries the independence
// constraint from non-partner pinned partner weeks).
function findMatchingForWeek(
  n: number,
  mustInclude: ReadonlyArray<Pair>,
  remaining: ReadonlyMap<PairKey, number>,
  excluded: ReadonlySet<PairKey>,
  shuffle: Shuffler,
): Matching | null {
  const matching: Matching = [];
  const paired = new Set<number>();
  for (const [a, b] of mustInclude) {
    if (a === b || paired.has(a) || paired.has(b)) return null;
    const k = pairKey(a, b);
    if ((remaining.get(k) ?? 0) <= 0) return null;
    paired.add(a);
    paired.add(b);
    matching.push([Math.min(a, b), Math.max(a, b)]);
  }
  const pickFirstUnpaired = (): number => {
    for (let i = 0; i < n; i++) if (!paired.has(i)) return i;
    return -1;
  };
  const backtrack = (): boolean => {
    if (paired.size === n) return true;
    const team = pickFirstUnpaired();
    const partners: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === team || paired.has(j)) continue;
      const k = pairKey(team, j);
      if ((remaining.get(k) ?? 0) > 0 && !excluded.has(k)) partners.push(j);
    }
    for (const p of shuffle(partners)) {
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

function buildMatchingsByWeek(
  n: number,
  weekCount: number,
  target: ReadonlyMap<PairKey, number>,
  weekMustInclude: ReadonlyMap<number, Pair[]>,
  nonPartnerPartners: ReadonlyMap<number, Set<number>>,
  shuffle: Shuffler,
): Matching[] | null {
  const pinnedWeeks: number[] = [];
  const unpinnedWeeks: number[] = [];
  for (let W = 1; W <= weekCount; W++) {
    if (weekMustInclude.has(W)) pinnedWeeks.push(W);
    else unpinnedWeeks.push(W);
  }
  // Pinned weeks first in numerical order so the exclude logic for the second
  // pinned week of a non-partner pair has the first week's matching available.
  pinnedWeeks.sort((a, b) => a - b);

  for (let outer = 0; outer < 50; outer++) {
    const remaining = new Map<PairKey, number>(target);
    const matchings: (Matching | null)[] = new Array(weekCount).fill(null);
    const matchingPairs = new Map<number, Set<PairKey>>();
    const order = [...pinnedWeeks, ...shuffle(unpinnedWeeks)];
    let ok = true;
    for (const W of order) {
      const must = weekMustInclude.get(W) ?? [];
      const exclude = new Set<PairKey>();
      const partners = nonPartnerPartners.get(W);
      if (partners) {
        const mustSet = new Set<PairKey>();
        for (const [a, b] of must) mustSet.add(pairKey(a, b));
        for (const pw of partners) {
          const pPairs = matchingPairs.get(pw);
          if (!pPairs) continue;
          for (const k of pPairs) {
            if (!mustSet.has(k)) exclude.add(k);
          }
        }
      }
      const m = findMatchingForWeek(n, must, remaining, exclude, shuffle);
      if (!m) {
        ok = false;
        break;
      }
      matchings[W - 1] = m;
      const pSet = new Set<PairKey>();
      for (const [a, b] of m) {
        const k = pairKey(a, b);
        remaining.set(k, (remaining.get(k) ?? 0) - 1);
        pSet.add(k);
      }
      matchingPairs.set(W, pSet);
    }
    if (ok) {
      let allZero = true;
      for (const [, r] of remaining) {
        if (r !== 0) {
          allZero = false;
          break;
        }
      }
      if (allZero) return matchings as Matching[];
    }
  }
  return null;
}

function buildScheduleWeekByWeek(
  teamCount: number,
  weekCount: number,
  format: FormatProperties,
  hardAvoid: ReadonlySet<PairKey>,
  softAvoid: ReadonlySet<PairKey>,
  pins: ReadonlyArray<RivalryPin>,
  shuffle: Shuffler,
): ScheduleResult {
  const dp = format.doublesPerTeam;
  const totalDoubled = (dp * teamCount) / 2;

  const pinResult = classifyPinsForWeekly(pins, format, hardAvoid);
  if ("error" in pinResult) {
    return { ok: false, reason: "generation-failed", message: pinResult.error };
  }
  const { forcedDoubled, forcedSingle, weekMustInclude, placements, nonPartnerPartners } =
    pinResult;

  const forcedDegree = new Array<number>(teamCount).fill(0);
  for (const k of forcedDoubled) {
    const [a, b] = unpackPairKey(k);
    forcedDegree[a]!++;
    forcedDegree[b]!++;
  }
  for (let i = 0; i < teamCount; i++) {
    if (forcedDegree[i]! > dp) {
      return { ok: false, reason: "generation-failed", message: PIN_FAIL_MESSAGE };
    }
  }

  for (let outerAttempt = 0; outerAttempt < 30; outerAttempt++) {
    let usingSoft = false;
    let doubled = pickDoubledSet(
      teamCount, dp, forcedDoubled, forcedSingle, hardAvoid, softAvoid, shuffle, totalDoubled,
    );
    if (!doubled) {
      doubled = pickDoubledSet(
        teamCount, dp, forcedDoubled, forcedSingle, hardAvoid, new Set(), shuffle, totalDoubled,
      );
      usingSoft = true;
      if (!doubled) continue;
    }

    const target = new Map<PairKey, number>();
    for (let i = 0; i < teamCount; i++) {
      for (let j = i + 1; j < teamCount; j++) {
        const k = pairKey(i, j);
        target.set(k, doubled.has(k) ? 2 : 1);
      }
    }

    const matchings = buildMatchingsByWeek(
      teamCount, weekCount, target, weekMustInclude, nonPartnerPartners, shuffle,
    );
    if (!matchings) continue;

    const doubledPairs = new Set<PairKey>();
    const counts = new Map<PairKey, number>();
    for (const week of matchings) {
      for (const [a, b] of week) {
        const k = pairKey(a, b);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    for (const [k, c] of counts) {
      if (c >= 2) doubledPairs.add(k);
    }
    const rivalryPinnedPairs = new Set<PairKey>();
    for (const p of placements) rivalryPinnedPairs.add(pairKey(p.teamA, p.teamB));
    const softRepeated: PairKey[] = [];
    const hardRepeated: PairKey[] = [];
    for (const k of doubledPairs) {
      if (rivalryPinnedPairs.has(k)) continue;
      if (softAvoid.has(k)) softRepeated.push(k);
      if (hardAvoid.has(k)) hardRepeated.push(k);
    }

    return {
      ok: true,
      weeks: matchings,
      doubledPairs,
      softRepeated,
      hardRepeated,
      clean: !usingSoft,
      format,
      rivalryPlacements: placements,
    };
  }
  return { ok: false, reason: "generation-failed", message: PIN_FAIL_MESSAGE };
}
