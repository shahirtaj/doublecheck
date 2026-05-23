import { describe, expect, it } from "vitest";
import type { LookbackWindow, Matching } from "@/lib/algorithm";
import type { ImportedSeasonRecord } from "./types";
import {
  computeDisplayWeeks,
  deriveLookback,
  detectFormatFromImport,
  extractSlug,
} from "./utils";

function makeSeason(
  teamCount: number,
  regWeeks: number | undefined,
): ImportedSeasonRecord {
  return {
    teamNames: Array.from({ length: teamCount }, (_, i) => `Team ${i + 1}`),
    userIds: Array.from({ length: teamCount }, () => null),
    doubles: [],
    regWeeks,
  };
}

describe("extractSlug", () => {
  it("returns the slug from a full URL", () => {
    expect(extractSlug("https://doublecheckff.com/s/abc12345")).toBe(
      "abc12345",
    );
  });

  it("returns the slug from a relative path", () => {
    expect(extractSlug("/s/abc12345")).toBe("abc12345");
  });

  it("returns the slug from a bare 8-char input", () => {
    expect(extractSlug("abc12345")).toBe("abc12345");
  });

  it("returns the slug from a URL with a trailing slash", () => {
    expect(extractSlug("https://doublecheckff.com/s/abc12345/")).toBe(
      "abc12345",
    );
  });

  it("returns the slug from a URL with a query string", () => {
    expect(extractSlug("https://doublecheckff.com/s/abc12345?ref=email")).toBe(
      "abc12345",
    );
  });

  it("returns the slug from a URL with a hash fragment", () => {
    expect(extractSlug("/s/abc12345#section")).toBe("abc12345");
  });

  it("lowercases an uppercase bare slug", () => {
    expect(extractSlug("ABC12345")).toBe("abc12345");
  });

  it("lowercases an uppercase URL slug", () => {
    expect(extractSlug("https://doublecheckff.com/s/ABC12345")).toBe(
      "abc12345",
    );
  });

  it("trims surrounding whitespace before matching", () => {
    expect(extractSlug("   abc12345   ")).toBe("abc12345");
  });

  it("returns null for an empty string", () => {
    expect(extractSlug("")).toBeNull();
  });

  it("returns null for whitespace only", () => {
    expect(extractSlug("   ")).toBeNull();
  });

  it("returns null for a 7-char bare slug", () => {
    expect(extractSlug("abc1234")).toBeNull();
  });

  it("returns null for a 9-char bare slug", () => {
    expect(extractSlug("abc123456")).toBeNull();
  });

  it("returns null for a bare slug with invalid characters", () => {
    expect(extractSlug("abc-1234")).toBeNull();
  });

  it("returns null for a URL without /s/", () => {
    expect(extractSlug("https://doublecheckff.com/abc12345")).toBeNull();
  });

  it("returns null for an unrelated URL", () => {
    expect(extractSlug("https://google.com")).toBeNull();
  });

  it("returns null when /s/ is followed by only 7 valid chars", () => {
    expect(extractSlug("/s/abc1234")).toBeNull();
  });

  it("returns null when /s/ is followed by more than 8 valid chars with no separator", () => {
    expect(extractSlug("/s/abc123456")).toBeNull();
  });
});

describe("detectFormatFromImport", () => {
  it.each([
    [8, 13],
    [10, 13],
    [10, 14],
    [12, 13],
    [12, 14],
    [14, 14],
    [14, 15],
  ])("detects %i-team / %i-week as a valid format", (teamCount, weekCount) => {
    expect(detectFormatFromImport(makeSeason(teamCount, weekCount))).toEqual({
      teamCount,
      weekCount,
    });
  });

  it("returns null for an odd team count", () => {
    expect(detectFormatFromImport(makeSeason(11, 13))).toBeNull();
  });

  it("returns null when regWeeks is missing", () => {
    expect(detectFormatFromImport(makeSeason(10, undefined))).toBeNull();
  });

  it("returns null when teamNames is empty", () => {
    expect(
      detectFormatFromImport({
        teamNames: [],
        userIds: [],
        doubles: [],
        regWeeks: 13,
      }),
    ).toBeNull();
  });

  it("returns null when weekCount is below teamCount - 1", () => {
    expect(detectFormatFromImport(makeSeason(8, 6))).toBeNull();
  });

  it("returns null when weekCount is above 2*(teamCount - 1)", () => {
    expect(detectFormatFromImport(makeSeason(8, 15))).toBeNull();
  });
});

describe("deriveLookback", () => {
  const formatLookback: LookbackWindow = { hard: 4, soft: 3 };

  it("reduces hard first when the override is below the hard count", () => {
    expect(deriveLookback(2, formatLookback)).toEqual({ hard: 2, soft: 0 });
  });

  it("preserves hard and reduces soft when the override sits between hard and total", () => {
    expect(deriveLookback(5, formatLookback)).toEqual({ hard: 4, soft: 1 });
  });

  it("returns the original window when the override equals hard + soft", () => {
    expect(deriveLookback(7, formatLookback)).toEqual({ hard: 4, soft: 3 });
  });

  it("returns {hard:0, soft:0} when the override is 0", () => {
    expect(deriveLookback(0, formatLookback)).toEqual({ hard: 0, soft: 0 });
  });

  it("keeps hard <= formatLookback.hard and soft = total - hard when the override exceeds total", () => {
    const result = deriveLookback(10, formatLookback);
    expect(result.hard).toBeLessThanOrEqual(formatLookback.hard);
    expect(result.soft).toBe(10 - result.hard);
  });
});

describe("computeDisplayWeeks", () => {
  const teams = ["Alpha", "Bravo", "Charlie", "Delta"];
  const weeks: Matching[] = [
    [
      [0, 1],
      [2, 3],
    ],
    [
      [0, 2],
      [1, 3],
    ],
    [
      [0, 3],
      [1, 2],
    ],
  ];

  it("preserves the input shape (same number of weeks and matchups per week)", () => {
    const result = computeDisplayWeeks(weeks, teams);
    expect(result).toHaveLength(weeks.length);
    result.forEach((week, i) => {
      expect(week).toHaveLength(weeks[i]!.length);
    });
  });

  it("balances left-side appearances within 1 across all teams", () => {
    const result = computeDisplayWeeks(weeks, teams);
    const leftCounts = new Array<number>(teams.length).fill(0);
    result.forEach((week) => {
      week.forEach(([left]) => leftCounts[left]!++);
    });
    const range = Math.max(...leftCounts) - Math.min(...leftCounts);
    expect(range).toBeLessThanOrEqual(1);
  });

  it("sorts each week's matchups alphabetically by left-side team name", () => {
    const result = computeDisplayWeeks(weeks, teams);
    result.forEach((week) => {
      const leftNames = week.map(([left]) => teams[left]!);
      const sorted = [...leftNames].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      );
      expect(leftNames).toEqual(sorted);
    });
  });

  it("preserves each matchup's team pair (only the left/right order may change)", () => {
    const result = computeDisplayWeeks(weeks, teams);
    result.forEach((week, weekIndex) => {
      const inputPairs = weeks[weekIndex]!.map(([a, b]) =>
        [Math.min(a, b), Math.max(a, b)].join("-"),
      ).sort();
      const outputPairs = week
        .map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join("-"))
        .sort();
      expect(outputPairs).toEqual(inputPairs);
    });
  });
});
