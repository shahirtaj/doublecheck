import { describe, expect, it } from "vitest";
import { buildSchedule, describeFormat, pairKey } from "./index";
import type { RivalryPin, ScheduleSuccess } from "./types";

// Mulberry32: small, fast, deterministic PRNG. Each test that needs random
// scheduling gets a fresh seed so failures are reproducible and tests don't
// influence each other.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type FormatCase = {
  teams: number;
  weeks: number;
  doublesPerTeam: number;
};

const FORMATS: FormatCase[] = [
  { teams: 8, weeks: 13, doublesPerTeam: 6 },
  { teams: 10, weeks: 13, doublesPerTeam: 4 },
  { teams: 10, weeks: 14, doublesPerTeam: 5 },
  { teams: 12, weeks: 13, doublesPerTeam: 2 },
  { teams: 12, weeks: 14, doublesPerTeam: 3 },
  { teams: 14, weeks: 14, doublesPerTeam: 1 },
  { teams: 14, weeks: 15, doublesPerTeam: 2 },
];

function assertSuccess(
  result: ReturnType<typeof buildSchedule>,
): asserts result is ScheduleSuccess {
  if (!result.ok) {
    throw new Error(`expected schedule to succeed, got ${"reason" in result ? result.reason : "unknown"}`);
  }
}

describe.each(FORMATS)(
  "$teams-team / $weeks-week",
  ({ teams, weeks, doublesPerTeam }) => {
    const singlesPerTeam = teams - 1 - doublesPerTeam;
    const result = buildSchedule({
      teamCount: teams,
      weekCount: weeks,
      random: mulberry32(0xc0ffee + teams * 100 + weeks),
    });

    it("generates a successful schedule", () => {
      expect(result.ok).toBe(true);
    });

    it("derives doublesPerTeam from weeks - (teams - 1)", () => {
      assertSuccess(result);
      expect(result.format.doublesPerTeam).toBe(doublesPerTeam);
      expect(result.format.singlesPerTeam).toBe(singlesPerTeam);
      expect(result.format.weekCount).toBe(weeks);
      expect(result.format.teamCount).toBe(teams);
    });

    it("produces exactly weekCount weeks", () => {
      assertSuccess(result);
      expect(result.weeks.length).toBe(weeks);
    });

    it("every week is a perfect matching covering all teams", () => {
      assertSuccess(result);
      for (const week of result.weeks) {
        expect(week.length).toBe(teams / 2);
        const seen = new Set<number>();
        for (const [a, b] of week) {
          expect(seen.has(a)).toBe(false);
          expect(seen.has(b)).toBe(false);
          seen.add(a);
          seen.add(b);
        }
        expect(seen.size).toBe(teams);
      }
    });

    it("every team plays exactly weekCount games", () => {
      assertSuccess(result);
      const counts = new Array(teams).fill(0);
      for (const week of result.weeks) {
        for (const [a, b] of week) {
          counts[a]++;
          counts[b]++;
        }
      }
      for (let i = 0; i < teams; i++) {
        expect(counts[i]).toBe(weeks);
      }
    });

    it("every team plays every opponent at least once", () => {
      assertSuccess(result);
      const opponents: Set<number>[] = Array.from({ length: teams }, () => new Set<number>());
      for (const week of result.weeks) {
        for (const [a, b] of week) {
          opponents[a]!.add(b);
          opponents[b]!.add(a);
        }
      }
      for (let i = 0; i < teams; i++) {
        expect(opponents[i]!.size).toBe(teams - 1);
      }
    });

    it("doubled pairs appear exactly twice; everyone else exactly once", () => {
      assertSuccess(result);
      const counts = new Map<string, number>();
      for (const week of result.weeks) {
        for (const [a, b] of week) {
          const k = pairKey(a, b);
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
      let doubledFound = 0;
      for (const [key, count] of counts) {
        if (result.doubledPairs.has(key)) {
          expect(count).toBe(2);
          doubledFound++;
        } else {
          expect(count).toBe(1);
        }
      }
      expect(doubledFound).toBe(result.doubledPairs.size);
      expect(result.doubledPairs.size).toBe((teams * doublesPerTeam) / 2);
    });

    it("doubled pair appearances are placed at maximum separation (weekCount - doublesPerTeam)", () => {
      assertSuccess(result);
      const expectedSeparation = weeks - doublesPerTeam;
      expect(result.format.separation).toBe(expectedSeparation);

      const appearances = new Map<string, number[]>();
      result.weeks.forEach((week, wi) => {
        for (const [a, b] of week) {
          const k = pairKey(a, b);
          if (!result.doubledPairs.has(k)) continue;
          const arr = appearances.get(k);
          if (arr) arr.push(wi);
          else appearances.set(k, [wi]);
        }
      });

      expect(appearances.size).toBe(result.doubledPairs.size);
      for (const [, [first, second]] of appearances) {
        expect(typeof first).toBe("number");
        expect(typeof second).toBe("number");
        expect((second as number) - (first as number)).toBe(expectedSeparation);
      }
    });

    it("singles decompose into singlesPerTeam perfect matchings in the middle weeks", () => {
      assertSuccess(result);
      const middle = result.weeks.slice(doublesPerTeam, weeks - doublesPerTeam);
      expect(middle.length).toBe(singlesPerTeam);

      const totalSinglePairs = (teams * singlesPerTeam) / 2;
      const allSingleKeys = new Set<string>();
      for (const week of middle) {
        expect(week.length).toBe(teams / 2);
        const seen = new Set<number>();
        for (const [a, b] of week) {
          expect(seen.has(a)).toBe(false);
          expect(seen.has(b)).toBe(false);
          seen.add(a);
          seen.add(b);
          const k = pairKey(a, b);
          expect(result.doubledPairs.has(k)).toBe(false);
          expect(allSingleKeys.has(k)).toBe(false);
          allSingleKeys.add(k);
        }
        expect(seen.size).toBe(teams);
      }
      expect(allSingleKeys.size).toBe(totalSinglePairs);
    });

    it("respects a hard-avoid set", () => {
      const hardAvoid = new Set([pairKey(0, 1)]);
      const r = buildSchedule({
        teamCount: teams,
        weekCount: weeks,
        hardAvoid,
        random: mulberry32(0xbeef + teams * 100 + weeks),
      });
      assertSuccess(r);
      for (const key of hardAvoid) {
        expect(r.doubledPairs.has(key)).toBe(false);
      }
      expect(r.hardRepeated).toEqual([]);
    });
  },
);

describe("describeFormat", () => {
  it.each(FORMATS)(
    "$teams/$weeks: doubles=$doublesPerTeam, singles, separation, rotation",
    ({ teams, weeks, doublesPerTeam }) => {
      const f = describeFormat(teams, weeks);
      const singlesPerTeam = teams - 1 - doublesPerTeam;
      expect(f.doublesPerTeam).toBe(doublesPerTeam);
      expect(f.singlesPerTeam).toBe(singlesPerTeam);
      expect(f.doubleMatchingsCount).toBe(doublesPerTeam);
      expect(f.singleMatchingsCount).toBe(singlesPerTeam);
      expect(f.separation).toBe(weeks - doublesPerTeam);
      expect(f.variant).toBe(doublesPerTeam > singlesPerTeam ? "inverted" : "standard");
    },
  );

  it.each([
    { teams: 8, weeks: 13, cycle: 7 }, // singles=1: rotate which opponent is your single
    { teams: 10, weeks: 13, cycle: 3 },
    { teams: 10, weeks: 14, cycle: 2 },
    { teams: 12, weeks: 13, cycle: 6 },
    { teams: 12, weeks: 14, cycle: 4 },
    { teams: 14, weeks: 14, cycle: 13 },
    { teams: 14, weeks: 15, cycle: 7 },
  ])("$teams/$weeks rotation cycle is $cycle", ({ teams, weeks, cycle }) => {
    expect(describeFormat(teams, weeks).rotationCycle).toBe(cycle);
  });

  it("12/14 lookback matches the prototype (2 hard, 1 soft)", () => {
    expect(describeFormat(12, 14).lookback).toEqual({ hard: 2, soft: 1 });
  });

  it("flags pure round-robin (14 teams / 13 weeks)", () => {
    const f = describeFormat(14, 13);
    expect(f.variant).toBe("pure-round-robin");
    expect(f.doublesPerTeam).toBe(0);
  });

  it("flags complete double round-robin (8 teams / 14 weeks)", () => {
    const f = describeFormat(8, 14);
    expect(f.variant).toBe("complete-double-round-robin");
    expect(f.singlesPerTeam).toBe(0);
  });
});

describe("buildSchedule rivalry pins", () => {
  function pinTo(week: number | null, a: number, b: number): RivalryPin {
    return { teamA: a, teamB: b, week };
  }

  function pairAppearances(r: ScheduleSuccess, a: number, b: number): number[] {
    const out: number[] = [];
    r.weeks.forEach((week, wi) => {
      for (const [x, y] of week) {
        if ((x === a && y === b) || (x === b && y === a)) out.push(wi + 1);
      }
    });
    return out;
  }

  it("places a one-pin pair as a single at the requested week (not doubled)", () => {
    // 12 teams / 14 weeks. Week 2 would be a default double slot, but a single
    // pin should NOT auto-double; the pair plays only week 2.
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(2, 0, 1)],
      random: mulberry32(0x1111),
    });
    assertSuccess(r);
    expect(pairAppearances(r, 0, 1)).toEqual([2]);
    expect(r.doubledPairs.has(pairKey(0, 1))).toBe(false);
    expect(r.rivalryPlacements).toEqual([
      { teamA: 0, teamB: 1, pinnedWeek: 2, placedWeek: 2 },
    ]);
  });

  it("places a one-pin pair as a single at a last-block week (not doubled)", () => {
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(13, 2, 3)],
      random: mulberry32(0x2222),
    });
    assertSuccess(r);
    expect(pairAppearances(r, 2, 3)).toEqual([13]);
    expect(r.doubledPairs.has(pairKey(2, 3))).toBe(false);
    expect(r.rivalryPlacements[0]!.placedWeek).toBe(13);
  });

  it("places a specific-week pin at a middle single week without doubling it", () => {
    // 12/14: middle weeks 4..11. Pin to week 6 → single slot 2.
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(6, 4, 5)],
      random: mulberry32(0x3333),
    });
    assertSuccess(r);
    expect(r.weeks[5]!.some(([a, b]) => (a === 4 && b === 5) || (a === 5 && b === 4))).toBe(true);
    expect(r.doubledPairs.has(pairKey(4, 5))).toBe(false);
    expect(r.rivalryPlacements[0]).toMatchObject({
      pinnedWeek: 6,
      placedWeek: 6,
    });
  });

  it("places multiple specific-week pins to the same week in the same matching", () => {
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(2, 0, 1), pinTo(2, 4, 5)],
      random: mulberry32(0x4444),
    });
    assertSuccess(r);
    const week2 = r.weeks[1]!;
    expect(week2.some(([a, b]) => (a === 0 && b === 1) || (a === 1 && b === 0))).toBe(true);
    expect(week2.some(([a, b]) => (a === 4 && b === 5) || (a === 5 && b === 4))).toBe(true);
  });

  it("rejects two pins that put the same team in the same week", () => {
    // Team 0 pinned twice to week 2 with different partners → impossible.
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(2, 0, 1), pinTo(2, 0, 3)],
      random: mulberry32(0x5555),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("generation-failed");
  });

  it("places an any-week pin and records the algorithm-chosen week", () => {
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(null, 0, 1)],
      random: mulberry32(0x6666),
    });
    assertSuccess(r);
    expect(r.rivalryPlacements).toHaveLength(1);
    const p = r.rivalryPlacements[0]!;
    expect(p.pinnedWeek).toBeNull();
    expect(p.placedWeek).toBeGreaterThanOrEqual(1);
    expect(p.placedWeek).toBeLessThanOrEqual(14);
    // Any-week pins should prefer middle (single) weeks to spread matchups.
    expect(p.placedWeek).toBeGreaterThanOrEqual(4);
    expect(p.placedWeek).toBeLessThanOrEqual(11);
    const placedIdx = p.placedWeek - 1;
    expect(
      r.weeks[placedIdx]!.some(
        ([a, b]) => (a === 0 && b === 1) || (a === 1 && b === 0),
      ),
    ).toBe(true);
  });

  it("spreads multiple any-week pins across different weeks", () => {
    const pins: RivalryPin[] = [
      pinTo(null, 0, 1),
      pinTo(null, 2, 3),
      pinTo(null, 4, 5),
    ];
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: pins,
      random: mulberry32(0x7777),
    });
    assertSuccess(r);
    const placedWeeks = r.rivalryPlacements.map((p) => p.placedWeek);
    expect(new Set(placedWeeks).size).toBe(placedWeeks.length);
  });

  it("single pin overrides avoidance for the pinned week only (not doubled)", () => {
    // (0,1) is hard-avoided. One pin to week 2 should let them play week 2
    // but the avoidance should still prevent a second appearance.
    const hardAvoid = new Set([pairKey(0, 1)]);
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      hardAvoid,
      rivalryPins: [pinTo(2, 0, 1)],
      random: mulberry32(0x8888),
    });
    assertSuccess(r);
    expect(pairAppearances(r, 0, 1)).toEqual([2]);
    expect(r.doubledPairs.has(pairKey(0, 1))).toBe(false);
    expect(r.hardRepeated).toEqual([]);
  });

  it("two pins for the same pair force a rivalry double and override avoidance fully", () => {
    const hardAvoid = new Set([pairKey(0, 1)]);
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      hardAvoid,
      rivalryPins: [pinTo(1, 0, 1), pinTo(10, 0, 1)],
      random: mulberry32(0x10a10),
    });
    assertSuccess(r);
    expect(pairAppearances(r, 0, 1)).toEqual([1, 10]);
    expect(r.doubledPairs.has(pairKey(0, 1))).toBe(true);
    expect(r.hardRepeated).toEqual([]);
    expect(r.rivalryPlacements).toHaveLength(2);
  });

  it("rejects an exact duplicate pin (same pair, same week)", () => {
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(3, 0, 1), pinTo(3, 0, 1)],
      random: mulberry32(0xd0c1),
    });
    expect(r.ok).toBe(false);
  });

  it("reports failure cleanly when pins are unsolvable", () => {
    // Pin every team's week-2 slot to a non-matching shape: pair (0,1), (0,2)
    // — team 0 can't play two opponents in the same week.
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(2, 0, 1), pinTo(2, 0, 2)],
      random: mulberry32(0x9999),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("generation-failed");
    expect(r.message).toMatch(/rivalry pins/i);
  });

  it("forces all three doubles for a single team via two-pin pairs", () => {
    // 12/14: team 0 has 3 doubles per season. Pin three different opponents
    // for doubles by pinning each pair to two weeks.
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [
        pinTo(1, 0, 1),
        pinTo(12, 0, 1),
        pinTo(2, 0, 2),
        pinTo(13, 0, 2),
        pinTo(3, 0, 3),
        pinTo(14, 0, 3),
      ],
      random: mulberry32(0xaaaa),
    });
    assertSuccess(r);
    expect(r.doubledPairs.has(pairKey(0, 1))).toBe(true);
    expect(r.doubledPairs.has(pairKey(0, 2))).toBe(true);
    expect(r.doubledPairs.has(pairKey(0, 3))).toBe(true);
    expect(pairAppearances(r, 0, 1)).toEqual([1, 12]);
    expect(pairAppearances(r, 0, 2)).toEqual([2, 13]);
    expect(pairAppearances(r, 0, 3)).toEqual([3, 14]);
  });

  it("any-week pin works alongside specific-week pins", () => {
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(2, 0, 1), pinTo(null, 2, 3)],
      random: mulberry32(0xbbbb),
    });
    assertSuccess(r);
    expect(r.rivalryPlacements).toHaveLength(2);
    const specific = r.rivalryPlacements.find((p) => p.pinnedWeek === 2)!;
    const any = r.rivalryPlacements.find((p) => p.pinnedWeek === null)!;
    expect(specific.placedWeek).toBe(2);
    expect(any.placedWeek).toBeGreaterThanOrEqual(1);
    expect(any.placedWeek).toBeLessThanOrEqual(14);
  });

  it("returns empty placements when no pins supplied", () => {
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      random: mulberry32(0xcccc),
    });
    assertSuccess(r);
    expect(r.rivalryPlacements).toEqual([]);
  });

  it("rejects pins referencing invalid team indices", () => {
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [{ teamA: 0, teamB: 99, week: 2 }],
      random: mulberry32(0xdddd),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("generation-failed");
  });

  it("rejects pins with the same team on both sides", () => {
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [{ teamA: 3, teamB: 3, week: 5 }],
      random: mulberry32(0xeeee),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("generation-failed");
  });

  it("rejects pins with week out of range", () => {
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(99, 0, 1)],
      random: mulberry32(0xffff),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("generation-failed");
  });

  // Pin + manual "✕" in the matrix. Manual ✕ adds the pair to the hard-avoid
  // set (it's the same code path), so this exercises the same override
  // semantics as a history-derived hard avoid.
  it("pin coexists with a manual hard-avoid (single appearance at pinned week)", () => {
    const hardAvoid = new Set([pairKey(0, 1)]);
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      hardAvoid,
      rivalryPins: [pinTo(3, 0, 1)],
      random: mulberry32(0xabcd),
    });
    assertSuccess(r);
    expect(pairAppearances(r, 0, 1)).toEqual([3]);
    expect(r.doubledPairs.has(pairKey(0, 1))).toBe(false);
  });

  it("same pair pinned to a specific week and any-week forces a double with distinct weeks", () => {
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(1, 0, 1), pinTo(null, 0, 1)],
      random: mulberry32(0x2233),
    });
    assertSuccess(r);
    const appearances = pairAppearances(r, 0, 1);
    expect(appearances).toHaveLength(2);
    expect(appearances).toContain(1);
    expect(appearances[0]).not.toBe(appearances[1]);
    expect(r.doubledPairs.has(pairKey(0, 1))).toBe(true);
  });

  it("single pin works for a non-avoided pair (plays at the pinned week)", () => {
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(5, 0, 1)],
      random: mulberry32(0x1234),
    });
    assertSuccess(r);
    expect(pairAppearances(r, 0, 1)).toContain(5);
  });

  it("single pin works with a soft-avoided pair (plays at the pinned week)", () => {
    const softAvoid = new Set([pairKey(0, 1)]);
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      softAvoid,
      rivalryPins: [pinTo(5, 0, 1)],
      random: mulberry32(0xa5a5),
    });
    assertSuccess(r);
    expect(pairAppearances(r, 0, 1)).toContain(5);
  });

  it("places an any-week pin into a remaining week when one team is heavily pinned", () => {
    // Lock team 0 into weeks 1-8 and 12-14 (11 of 14 weeks) — three forced
    // doubles plus five singles. Team 0's free weeks are 9, 10, 11 (its third
    // single double pair must come from opponents 10 and 11, placed by the
    // algorithm). An any-week pin for (0, 9) should land in 9/10/11.
    const pins: RivalryPin[] = [
      pinTo(1, 0, 1),
      pinTo(12, 0, 1),
      pinTo(2, 0, 2),
      pinTo(13, 0, 2),
      pinTo(3, 0, 3),
      pinTo(14, 0, 3),
      pinTo(4, 0, 4),
      pinTo(5, 0, 5),
      pinTo(6, 0, 6),
      pinTo(7, 0, 7),
      pinTo(8, 0, 8),
      pinTo(null, 0, 9),
    ];

    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: pins,
      random: mulberry32(0x6666),
    });
    assertSuccess(r);
    const placement = r.rivalryPlacements.find(
      (p) => p.pinnedWeek === null && p.teamA === 0 && p.teamB === 9,
    );
    expect(placement).toBeDefined();
    expect([9, 10, 11]).toContain(placement!.placedWeek);
  });

  it("errors cleanly when an any-week pin cannot fit a fully pinned team", () => {
    // Pin team 0 to all 14 weeks: three forced doubles (6 pins) + 8 singles.
    const pins: RivalryPin[] = [
      pinTo(1, 0, 1),
      pinTo(12, 0, 1),
      pinTo(2, 0, 2),
      pinTo(13, 0, 2),
      pinTo(3, 0, 3),
      pinTo(14, 0, 3),
    ];
    for (let opp = 4; opp <= 11; opp++) pins.push(pinTo(opp, 0, opp));
    // Adding any-week pin for (0, 4) would make it a forced double — but team
    // 0 has no free week left for the second appearance.
    pins.push(pinTo(null, 0, 4));

    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: pins,
      random: mulberry32(0x7777),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("generation-failed");
  });

  it("rejects more than maxPinsPerPair pins for one pair", () => {
    // 12/14 → max = ceil(14/11) = 2. A third pin for the same pair is invalid.
    const r = buildSchedule({
      teamCount: 12,
      weekCount: 14,
      rivalryPins: [pinTo(1, 0, 1), pinTo(10, 0, 1), pinTo(null, 0, 1)],
      random: mulberry32(0x8888),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("generation-failed");
  });
});

describe("buildSchedule edge cases", () => {
  it("returns a pure-round-robin message for 14 teams / 13 weeks", () => {
    const r = buildSchedule({ teamCount: 14, weekCount: 13 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("pure-round-robin");
    expect(r.message).toMatch(/pure round-robin/i);
  });

  it("returns a complete-double-round-robin message for 8 teams / 14 weeks", () => {
    const r = buildSchedule({ teamCount: 8, weekCount: 14 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("complete-double-round-robin");
    expect(r.message).toMatch(/double round-robin/i);
  });

  it("rejects odd team counts", () => {
    const r = buildSchedule({ teamCount: 11, weekCount: 14 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid-format");
  });

  it("rejects week counts below a single round-robin", () => {
    const r = buildSchedule({ teamCount: 12, weekCount: 10 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid-format");
  });

  it("rejects week counts above two full round-robins", () => {
    const r = buildSchedule({ teamCount: 8, weekCount: 15 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid-format");
  });
});
