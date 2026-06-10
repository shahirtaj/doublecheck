import { describe, expect, it } from "vitest";
import type { LookbackWindow, Matching, SeasonHistory } from "@/lib/algorithm";
import type { ImportedSeasonRecord } from "./types";
import {
  buildScheduleText,
  computeDisplayWeeks,
  deriveLookback,
  detectFormatFromImport,
  extractSlug,
  mergeImportedHistory,
  normalizeHistory,
  priorSeasons,
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

describe("priorSeasons", () => {
  it("drops an entry whose season equals year", () => {
    const history: SeasonHistory[] = [
      { season: "2024", doubles: [] },
      { season: "2025", doubles: [] },
    ];
    const result = priorSeasons(history, 2025);
    expect(result.map((h) => h.season)).toEqual(["2024"]);
  });

  it("keeps all entries when every season is earlier", () => {
    const history: SeasonHistory[] = [
      { season: "2022", doubles: [] },
      { season: "2023", doubles: [] },
      { season: "2024", doubles: [] },
    ];
    expect(priorSeasons(history, 2025)).toEqual(history);
  });

  it("keeps an entry with a non-numeric season string", () => {
    const history: SeasonHistory[] = [{ season: "Last year", doubles: [] }];
    expect(priorSeasons(history, 2025)).toEqual(history);
  });

  it("drops a future-year entry (season > year)", () => {
    const history: SeasonHistory[] = [
      { season: "2024", doubles: [] },
      { season: "2026", doubles: [] },
    ];
    const result = priorSeasons(history, 2025);
    expect(result.map((h) => h.season)).toEqual(["2024"]);
  });

  it("returns [] for empty history", () => {
    expect(priorSeasons([], 2025)).toEqual([]);
  });
});

describe("normalizeHistory", () => {
  it("keeps the last row for a duplicated year and re-sorts", () => {
    const rows: SeasonHistory[] = [
      { season: "2024", doubles: ["0-1"], format: "index" },
      { season: "2023", doubles: ["2-3"], format: "index" },
      { season: "2024", doubles: ["4-5"], format: "index" },
    ];
    expect(normalizeHistory(rows)).toEqual([
      { season: "2023", doubles: ["2-3"], format: "index" },
      { season: "2024", doubles: ["4-5"], format: "index" },
    ]);
  });

  it("sorts out-of-order rows ascending by numeric year", () => {
    const rows: SeasonHistory[] = [
      { season: "2024", doubles: [] },
      { season: "2021", doubles: [] },
      { season: "2023", doubles: [] },
    ];
    expect(normalizeHistory(rows).map((h) => h.season)).toEqual([
      "2021",
      "2023",
      "2024",
    ]);
  });

  it("keeps a row with a non-numeric season label", () => {
    const rows: SeasonHistory[] = [
      { season: "Last year", doubles: ["0-1"] },
      { season: "2024", doubles: [] },
    ];
    expect(normalizeHistory(rows)).toHaveLength(2);
  });

  it("returns [] for empty input", () => {
    expect(normalizeHistory([])).toEqual([]);
  });
});

describe("mergeImportedHistory", () => {
  it("replaces a same-year row with different doubles (imported wins)", () => {
    const existing: SeasonHistory[] = [
      { season: "2024", doubles: ["0-1", "2-3"], format: "index" },
    ];
    const imported: SeasonHistory[] = [
      { season: "2024", doubles: ["u1:u2"], format: "userid" },
    ];
    expect(mergeImportedHistory(existing, imported)).toEqual([
      { season: "2024", doubles: ["u1:u2"], format: "userid" },
    ]);
  });

  it("re-sorts chronologically with a manual row in the middle", () => {
    const existing: SeasonHistory[] = [
      { season: "2024", doubles: ["0-1"], format: "index" },
    ];
    const imported: SeasonHistory[] = [
      { season: "2021", doubles: [], format: "userid" },
      { season: "2022", doubles: [], format: "userid" },
      { season: "2023", doubles: [], format: "userid" },
      { season: "2025", doubles: [], format: "userid" },
    ];
    const result = mergeImportedHistory(existing, imported);
    expect(result.map((h) => h.season)).toEqual([
      "2021",
      "2022",
      "2023",
      "2024",
      "2025",
    ]);
    expect(result[3]).toEqual({
      season: "2024",
      doubles: ["0-1"],
      format: "index",
    });
  });

  it("is a no-op for an exact duplicate reimport", () => {
    const existing: SeasonHistory[] = [
      { season: "2023", doubles: ["0-1"], format: "index" },
      { season: "2024", doubles: ["2-3"], format: "index" },
    ];
    const imported: SeasonHistory[] = [
      { season: "2023", doubles: ["0-1"], format: "index" },
      { season: "2024", doubles: ["2-3"], format: "index" },
    ];
    expect(mergeImportedHistory(existing, imported)).toEqual(existing);
  });

  it("keeps a current-year Save & Share row not present in the import", () => {
    const existing: SeasonHistory[] = [
      { season: "2026", doubles: ["0-1"], format: "index" },
    ];
    const imported: SeasonHistory[] = [
      { season: "2024", doubles: [], format: "userid" },
      { season: "2025", doubles: [], format: "userid" },
    ];
    expect(
      mergeImportedHistory(existing, imported).map((h) => h.season),
    ).toEqual(["2024", "2025", "2026"]);
  });
});

describe("buildScheduleText", () => {
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
  ];

  it("formats weeks with double-spaced vs and blank lines between weeks", () => {
    expect(buildScheduleText(weeks, teams, "sleeper", "")).toBe(
      "Week 1\n  Alpha  vs  Bravo\n  Charlie  vs  Delta\n\n" +
        "Week 2\n  Alpha  vs  Charlie\n  Bravo  vs  Delta",
    );
  });

  it("prepends the heading prefix verbatim", () => {
    expect(
      buildScheduleText(
        [[[0, 1]]],
        teams,
        "sleeper",
        "My League 2026 Schedule\n\n",
      ),
    ).toBe("My League 2026 Schedule\n\nWeek 1\n  Alpha  vs  Bravo");
  });

  it("appends Yahoo attribution when the platform is yahoo", () => {
    expect(buildScheduleText([[[0, 1]]], teams, "yahoo", "")).toBe(
      "Week 1\n  Alpha  vs  Bravo\n\n" +
        "Fantasy data provided by Yahoo Fantasy\nhttps://sports.yahoo.com/fantasy/",
    );
  });

  it("omits attribution for a non-yahoo or absent platform", () => {
    expect(buildScheduleText([[[0, 1]]], teams, undefined, "")).toBe(
      "Week 1\n  Alpha  vs  Bravo",
    );
  });

  it("returns just the heading prefix for empty weeks", () => {
    expect(buildScheduleText([], teams, "sleeper", "Heading\n\n")).toBe(
      "Heading\n\n",
    );
  });
});
