import { describe, expect, it } from "vitest";
import { buildSchedule, describeFormat, pairKey } from "./index";
import type { ScheduleSuccess } from "./types";

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
