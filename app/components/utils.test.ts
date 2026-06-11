import { describe, expect, it } from "vitest";
import type {
  LookbackWindow,
  Matching,
  ScheduleResult,
  SeasonHistory,
} from "@/lib/algorithm";
import { CURRENT_YEAR, MAX_IMPORT_SEASONS } from "./constants";
import type { ImportedSeasonRecord, SelectedFormat } from "./types";
import {
  buildImportedHistoryRows,
  buildScheduleText,
  computeDisplayWeeks,
  deriveLookback,
  describeWithholdingGap,
  detectFormatFromImport,
  extractSlug,
  formatDetectionErrorMessage,
  generateWithRetry,
  generationFailureMessage,
  importSeasonsParam,
  mergeImportedHistory,
  normalizeHistory,
  priorSeasonAges,
  priorSeasons,
  remapIndexRowsByName,
  sharesRoster,
  withholdingErrorMessage,
  withholdingWarningMessage,
  withholdPreGapSeasons,
  yahooOAuthReturnPatch,
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

describe("formatDetectionErrorMessage", () => {
  it("names the three-matchups cause for a too-long regular season", () => {
    // The case that motivated cause-specific messaging: a real 8-team /
    // 15-week league (someone plays a third matchup) is out of scope, not
    // malformed - the message must say which, or the commissioner has
    // nothing to act on.
    expect(formatDetectionErrorMessage(makeSeason(8, 15))).toBe(
      "Could not detect a valid league format - a 15-week regular season is longer than two full round-robins for 8 teams (14 weeks), so some opponents play three or more times. DoubleCheck only schedules each opponent once or twice.",
    );
  });

  it("names the incomplete-round-robin cause for a too-short regular season", () => {
    expect(formatDetectionErrorMessage(makeSeason(12, 9))).toBe(
      "Could not detect a valid league format - a 9-week regular season is shorter than a single round-robin for 12 teams (11 weeks), and incomplete round-robins are not supported.",
    );
  });

  it("names an odd team count", () => {
    expect(formatDetectionErrorMessage(makeSeason(11, 13))).toBe(
      "Could not detect a valid league format - the most recent season has 11 teams, and odd-sized leagues are not supported.",
    );
  });

  it("names a missing regular-season week count", () => {
    expect(formatDetectionErrorMessage(makeSeason(10, undefined))).toBe(
      "Could not detect a valid league format - the most recent season is missing a regular-season week count.",
    );
  });

  it("names missing team data", () => {
    expect(
      formatDetectionErrorMessage({
        teamNames: [],
        userIds: [],
        doubles: [],
        regWeeks: 13,
      }),
    ).toBe(
      "Could not detect a valid league format - the most recent season has no team data.",
    );
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

describe("importSeasonsParam", () => {
  it("requests the works-for-any-format maximum when the format is unknown", () => {
    expect(importSeasonsParam(null)).toBe(MAX_IMPORT_SEASONS);
  });

  it("requests the recommended lookback plus the anchor season for a known format", () => {
    // 12/14: hard 2 + soft 1 prior seasons, + 1 for the newest season.
    expect(importSeasonsParam({ teamCount: 12, weekCount: 14 })).toBe(4);
    // 10/13: hard 1 + soft 1, + 1.
    expect(importSeasonsParam({ teamCount: 10, weekCount: 13 })).toBe(3);
  });

  it("reaches exactly the cap for the largest-lookback format (14/14)", () => {
    // hard 12 + soft 1 priors + 1 anchor = 14; anything past this would be
    // clamped server-side, silently shrinking the avoidance window.
    expect(importSeasonsParam({ teamCount: 14, weekCount: 14 })).toBe(
      MAX_IMPORT_SEASONS,
    );
  });

  it("requests only the anchor season for formats with no lookback", () => {
    // Pure round-robin and complete double round-robin use no history; the
    // newest season still supplies the roster and format detection.
    expect(importSeasonsParam({ teamCount: 14, weekCount: 13 })).toBe(1);
    expect(importSeasonsParam({ teamCount: 8, weekCount: 14 })).toBe(1);
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

  // Pair (0, 1) at week 1: every count is zero, so the parity tiebreaker
  // ((0 + 1 + 0) % 2 = 1) flips it - the unpinned baseline the pin tests
  // override.
  it("renders a pinned matchup in its entered order", () => {
    const unpinned = computeDisplayWeeks(weeks, teams);
    expect(unpinned[0]).toContainEqual([1, 0]);

    const pinned = computeDisplayWeeks(weeks, teams, [
      { teamA: 0, teamB: 1, week: 1 },
    ]);
    expect(pinned[0]).toContainEqual([0, 1]);
  });

  it("renders each leg of a two-pin rivalry in its own entered order", () => {
    // Pair (0, 1) doubled at weeks 1 and 3; the user entered the legs in
    // opposite orders, so each week shows its own pin's order.
    const doubled: Matching[] = [
      [
        [0, 1],
        [2, 3],
      ],
      [
        [0, 2],
        [1, 3],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    ];
    const result = computeDisplayWeeks(doubled, teams, [
      { teamA: 1, teamB: 0, week: 1 },
      { teamA: 0, teamB: 1, week: 3 },
    ]);
    expect(result[0]).toContainEqual([1, 0]);
    expect(result[2]).toContainEqual([0, 1]);
  });

  it("keeps both legs in the entered order when both pins match (no auto-flip)", () => {
    // Deliberately NOT auto-flipped into home-and-home: entered order is
    // the contract even when both pins were entered the same way - the
    // Rivalry Weeks hint teaches the opposite-orders recipe instead of
    // overriding the user's input.
    const doubled: Matching[] = [
      [
        [0, 1],
        [2, 3],
      ],
      [
        [0, 2],
        [1, 3],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    ];
    const result = computeDisplayWeeks(doubled, teams, [
      { teamA: 1, teamB: 0, week: 1 },
      { teamA: 1, teamB: 0, week: 3 },
    ]);
    expect(result[0]).toContainEqual([1, 0]);
    expect(result[2]).toContainEqual([1, 0]);
  });

  it("flips the unpinned leg of a doubled one-pin rivalry (home-and-home)", () => {
    const doubled: Matching[] = [
      [
        [0, 1],
        [2, 3],
      ],
      [
        [0, 2],
        [1, 3],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    ];
    const result = computeDisplayWeeks(doubled, teams, [
      { teamA: 0, teamB: 1, week: 3 },
    ]);
    // Week 3 is the pinned leg (entered order); week 1 is the natural
    // double's other leg, so it flips.
    expect(result[2]).toContainEqual([0, 1]);
    expect(result[0]).toContainEqual([1, 0]);
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

describe("sharesRoster", () => {
  const season = (
    teamNames: string[],
    seasonUserIds: (string | null)[],
  ): ImportedSeasonRecord => ({
    teamNames,
    userIds: seasonUserIds,
    doubles: [],
  });

  it("matches on a shared user ID even when every name differs", () => {
    expect(
      sharesRoster(
        ["Old Name A", "Old Name B"],
        ["u1", "u2"],
        season(["New Name A", "New Name B"], ["u2", "u9"]),
      ),
    ).toBe(true);
  });

  it("treats disjoint ID sets as a different league even when names collide", () => {
    // Two leagues full of default "Team N" names must not merge.
    expect(
      sharesRoster(
        ["Team 1", "Team 2"],
        ["u1", "u2"],
        season(["Team 1", "Team 2"], ["u8", "u9"]),
      ),
    ).toBe(false);
  });

  it("falls back to name overlap when either side has no IDs", () => {
    expect(
      sharesRoster(
        ["Alpha", "Bravo"],
        [null, null],
        season(["Bravo", "Charlie"], ["u1", "u2"]),
      ),
    ).toBe(true);
  });

  it("returns false when nothing overlaps", () => {
    expect(
      sharesRoster(
        ["Alpha", "Bravo"],
        [null, null],
        season(["Charlie", "Delta"], [null, null]),
      ),
    ).toBe(false);
  });
});

describe("remapIndexRowsByName", () => {
  it("re-keys index pairs onto the re-sorted roster and drops vanished names", () => {
    // "Alpha" renamed to "Whiskey": old sorted order [Alpha, Bravo, Zed]
    // becomes [Bravo, Whiskey, Zed], shifting Bravo and stranding Alpha.
    const rows = remapIndexRowsByName(
      [{ season: "2023", doubles: ["0-1", "1-2"], format: "index" }],
      ["Alpha", "Bravo", "Zed"],
      ["Bravo", "Whiskey", "Zed"],
    );
    // (Alpha, Bravo) dropped - Alpha's name is gone; (Bravo, Zed) -> (0, 2).
    expect(rows).toEqual([
      { season: "2023", doubles: ["0-2"], format: "index" },
    ]);
  });

  it("passes userid rows and legacy colon keys through untouched", () => {
    const rows = remapIndexRowsByName(
      [
        { season: "2022", doubles: ["u1:u2"], format: "userid" },
        { season: "2023", doubles: ["u1:u2", "0-1"], format: "index" },
      ],
      ["Alpha", "Bravo"],
      ["Alpha", "Bravo"],
    );
    expect(rows).toEqual([
      { season: "2022", doubles: ["u1:u2"], format: "userid" },
      { season: "2023", doubles: ["u1:u2", "0-1"], format: "index" },
    ]);
  });
});

describe("priorSeasonAges", () => {
  const row = (season: string): SeasonHistory => ({
    season,
    doubles: [],
    format: "index",
  });

  it("ages prior seasons positionally and omits the in-progress season", () => {
    const ages = priorSeasonAges(
      [row("2023"), row("2024"), row("2025"), row("2026")],
      2026,
    );
    expect(ages.get("2025")).toBe(1);
    expect(ages.get("2024")).toBe(2);
    expect(ages.get("2023")).toBe(3);
    expect(ages.has("2026")).toBe(false);
  });

  it("matches full-history aging when no in-progress season is recorded", () => {
    const ages = priorSeasonAges([row("2024"), row("2025")], 2026);
    expect(ages.get("2025")).toBe(1);
    expect(ages.get("2024")).toBe(2);
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

describe("buildImportedHistoryRows", () => {
  // Platform order differs from alphabetical so index remapping is visible:
  // sorted roster is [Alpha, Mike, Zed] -> indices 0, 1, 2.
  const sortedTeams = ["Alpha", "Mike", "Zed"];
  const season = (
    overrides: Partial<ImportedSeasonRecord>,
  ): ImportedSeasonRecord => ({
    seasonYear: "2024",
    teamNames: ["Zed", "Alpha", "Mike"],
    userIds: ["u-zed", "u-alpha", "u-mike"],
    doubles: [],
    ...overrides,
  });

  it("uses userid format when every team has a user ID", () => {
    const rows = buildImportedHistoryRows(
      [season({ doubles: ["0-1", "1-2"] })],
      sortedTeams,
    );
    expect(rows).toEqual([
      {
        season: "2024",
        doubles: ["u-alpha:u-zed", "u-alpha:u-mike"],
        format: "userid",
      },
    ]);
  });

  it("keeps userid format when an ID is missing, dropping that team's pairs", () => {
    // Zed has no owner. The row stays userid format (IDs survive team
    // renames; demoting the whole season to index format would key every
    // pair by name) and Zed's pairs are skipped openly - the same pairs
    // resolveKey already discarded when they arrived as broken "u-alpha:"
    // half-keys.
    const rows = buildImportedHistoryRows(
      [
        season({
          userIds: [null, "u-alpha", "u-mike"],
          doubles: ["0-1", "1-2"],
        }),
      ],
      sortedTeams,
    );
    // (Zed, Alpha) dropped - Zed has no ID; (Alpha, Mike) kept as userid key.
    expect(rows).toEqual([
      { season: "2024", doubles: ["u-alpha:u-mike"], format: "userid" },
    ]);
  });

  it("drops index pairs naming teams no longer in the roster", () => {
    const rows = buildImportedHistoryRows(
      [
        season({
          userIds: [null, null, null],
          teamNames: ["Zed", "Departed", "Mike"],
          doubles: ["0-1", "0-2"],
        }),
      ],
      sortedTeams,
    );
    expect(rows).toEqual([
      { season: "2024", doubles: ["1-2"], format: "index" },
    ]);
  });

  it("labels a season missing its year as the previous year", () => {
    const rows = buildImportedHistoryRows(
      [season({ seasonYear: "" })],
      sortedTeams,
    );
    expect(rows[0]!.season).toBe(String(CURRENT_YEAR - 1));
  });
});

describe("withholdPreGapSeasons", () => {
  function yearSeason(year: string): ImportedSeasonRecord {
    return { ...makeSeason(10, 13), seasonYear: year };
  }
  const failedYear = (season: string) => ({ season, error: "HTTP 502" });
  const historyRow = (season: string): SeasonHistory => ({
    season,
    doubles: [],
  });

  it("drops seasons older than a middle gap", () => {
    const result = withholdPreGapSeasons(
      ["2025", "2024", "2022", "2021"].map(yearSeason),
      [failedYear("2023")],
      [],
    );
    expect(result.kept.map((s) => s.seasonYear)).toEqual(["2025", "2024"]);
    expect(result.withheldYears).toEqual(["2022", "2021"]);
    expect(result.gapYears).toEqual(["2023"]);
  });

  it("drops nothing when the failed year is already in history", () => {
    const result = withholdPreGapSeasons(
      ["2025", "2024", "2022"].map(yearSeason),
      [failedYear("2023")],
      [historyRow("2023")],
    );
    expect(result.kept.map((s) => s.seasonYear)).toEqual([
      "2025",
      "2024",
      "2022",
    ]);
    expect(result.withheldYears).toEqual([]);
    expect(result.gapYears).toEqual([]);
  });

  it("keeps nothing when the newest attempted season failed", () => {
    const result = withholdPreGapSeasons(
      ["2024", "2023"].map(yearSeason),
      [failedYear("2025")],
      [],
    );
    expect(result.kept).toEqual([]);
    expect(result.withheldYears).toEqual(["2024", "2023"]);
    expect(result.gapYears).toEqual(["2025"]);
  });

  it("anchors on the newest of multiple gaps", () => {
    const result = withholdPreGapSeasons(
      ["2025", "2023", "2022", "2020"].map(yearSeason),
      [failedYear("2021"), failedYear("2024")],
      [],
    );
    expect(result.kept.map((s) => s.seasonYear)).toEqual(["2025"]);
    expect(result.withheldYears).toEqual(["2023", "2022", "2020"]);
    expect(result.gapYears).toEqual(["2024", "2021"]);
  });

  it("anchors on the next-newest gap when history fills the newest one", () => {
    const result = withholdPreGapSeasons(
      ["2025", "2023", "2021"].map(yearSeason),
      [failedYear("2024"), failedYear("2022")],
      [historyRow("2024")],
    );
    expect(result.kept.map((s) => s.seasonYear)).toEqual(["2025", "2023"]);
    expect(result.withheldYears).toEqual(["2021"]);
    expect(result.gapYears).toEqual(["2022"]);
  });

  it("is a no-op with no failures", () => {
    const seasons = ["2025", "2024", "2023"].map(yearSeason);
    const result = withholdPreGapSeasons(seasons, [], []);
    expect(result.kept).toEqual(seasons);
    expect(result.withheldYears).toEqual([]);
    expect(result.gapYears).toEqual([]);
  });

  it("withholds nothing when only the oldest attempted season failed", () => {
    const result = withholdPreGapSeasons(
      ["2025", "2024", "2023"].map(yearSeason),
      [failedYear("2022")],
      [],
    );
    expect(result.kept.map((s) => s.seasonYear)).toEqual([
      "2025",
      "2024",
      "2023",
    ]);
    expect(result.withheldYears).toEqual([]);
    expect(result.gapYears).toEqual(["2022"]);
  });

  it("ignores a failed season without a numeric year label", () => {
    const seasons = ["2025", "2024"].map(yearSeason);
    const result = withholdPreGapSeasons(seasons, [failedYear("")], []);
    expect(result.kept).toEqual(seasons);
    expect(result.withheldYears).toEqual([]);
    expect(result.gapYears).toEqual([]);
  });

  it("withholds an imported season without a numeric year once a gap exists", () => {
    const result = withholdPreGapSeasons(
      [yearSeason("2025"), yearSeason(""), yearSeason("2022")],
      [failedYear("2023")],
      [],
    );
    expect(result.kept.map((s) => s.seasonYear)).toEqual(["2025"]);
    expect(result.withheldYears).toEqual(["?", "2022"]);
  });

  // Roster-filtered years flow in through the same `failed` parameter as
  // fetch failures (previewFetchedSeasons unions them) — the decision is
  // cause-blind, so these mirror the fetch-failure cases above.
  const rosterFiltered = (season: string) => ({
    season,
    error: "different roster size",
  });

  it("withholds seasons older than a roster-filtered middle year", () => {
    // 12 -> 10 -> 12 league: the 10-team 2023 was dropped by the format
    // filter, leaving 2022/2021 behind a hole.
    const result = withholdPreGapSeasons(
      ["2025", "2024", "2022", "2021"].map(yearSeason),
      [rosterFiltered("2023")],
      [],
    );
    expect(result.kept.map((s) => s.seasonYear)).toEqual(["2025", "2024"]);
    expect(result.withheldYears).toEqual(["2022", "2021"]);
    expect(result.gapYears).toEqual(["2023"]);
  });

  it("withholds nothing when history fills the roster-filtered year", () => {
    const result = withholdPreGapSeasons(
      ["2025", "2024", "2022"].map(yearSeason),
      [rosterFiltered("2023")],
      [historyRow("2023")],
    );
    expect(result.kept.map((s) => s.seasonYear)).toEqual([
      "2025",
      "2024",
      "2022",
    ]);
    expect(result.withheldYears).toEqual([]);
    expect(result.gapYears).toEqual([]);
  });

  it("anchors on the newest of a fetch failure and a roster drop", () => {
    const result = withholdPreGapSeasons(
      ["2025", "2023", "2021"].map(yearSeason),
      [failedYear("2024"), rosterFiltered("2022")],
      [],
    );
    expect(result.kept.map((s) => s.seasonYear)).toEqual(["2025"]);
    expect(result.withheldYears).toEqual(["2023", "2021"]);
    expect(result.gapYears).toEqual(["2024", "2022"]);
  });

  it("is a no-op when the roster-filtered run is the oldest", () => {
    const result = withholdPreGapSeasons(
      ["2025", "2024", "2023"].map(yearSeason),
      [rosterFiltered("2022"), rosterFiltered("2021")],
      [],
    );
    expect(result.kept.map((s) => s.seasonYear)).toEqual([
      "2025",
      "2024",
      "2023",
    ]);
    expect(result.withheldYears).toEqual([]);
    expect(result.gapYears).toEqual(["2022", "2021"]);
  });
});

describe("describeWithholdingGap", () => {
  // 12-team / 14-week: lookback hard 2 + soft 1, so the Add Past Season
  // year dropdown reaches back to CURRENT_YEAR - 3. Gap years are relative
  // to the current year so fillability stays deterministic as years pass.
  const detected: SelectedFormat = { teamCount: 12, weekCount: 14 };
  const oldestOfferableYear = CURRENT_YEAR - 3;
  const y = (yearsAgo: number) => String(CURRENT_YEAR - yearsAgo);
  const droppedSeason = (year: string, teamCount: number) => ({
    ...makeSeason(teamCount, 13),
    seasonYear: year,
  });

  it("names the failed year and offers retry for a fetch-failure-only gap", () => {
    const { cause, remedy } = describeWithholdingGap(
      [y(3)],
      [{ season: y(3), error: "HTTP 502" }],
      [],
      detected,
    );
    expect(cause).toBe(`${y(3)} failed to import`);
    expect(remedy).toBe(
      `Retry the import, or add ${y(3)} via Add Past Season and re-import.`,
    );
  });

  it("names the roster sizes and never suggests retry for a roster-filter gap", () => {
    const { cause, remedy } = describeWithholdingGap(
      [y(2)],
      [],
      [droppedSeason(y(2), 10)],
      detected,
    );
    expect(cause).toBe(
      `${y(2)} was a 10-team season (this import is 12 teams)`,
    );
    expect(remedy).toBe(
      `Retrying won't change this - to keep the older seasons, add ${y(2)} via Add Past Season (marking that season's doubled matchups among the current teams), then re-import.`,
    );
    expect(remedy).not.toMatch(/Retry the import|may recover/);
  });

  it("names both causes when fetch and roster gaps mix", () => {
    const { cause, remedy } = describeWithholdingGap(
      [y(1), y(2)],
      [{ season: y(1), error: "HTTP 502" }],
      [droppedSeason(y(2), 10)],
      detected,
    );
    expect(cause).toBe(
      `${y(1)} failed to import, and ${y(2)} was a 10-team season (this import is 12 teams)`,
    );
    expect(remedy).toBe(
      `Retrying may recover ${y(1)}; ${y(2)} needs Add Past Season (marking doubles among the current teams) before a re-import can keep the older seasons.`,
    );
  });

  it("says the seasons can't be restored when the dropdown can't offer the gap year", () => {
    const { remedy } = describeWithholdingGap(
      [y(6)],
      [],
      [droppedSeason(y(6), 10)],
      detected,
    );
    expect(remedy).toBe(
      `Retrying won't change this, and Add Past Season only reaches back to ${oldestOfferableYear}, so the older seasons can't be restored.`,
    );
    expect(remedy).not.toContain("via Add Past Season");
  });

  it("advertises only the fillable roster gaps, not the unreachable ones", () => {
    const { remedy } = describeWithholdingGap(
      [y(2), y(6)],
      [],
      [droppedSeason(y(2), 10), droppedSeason(y(6), 8)],
      detected,
    );
    expect(remedy).toBe(
      `Retrying won't change this - to keep the older seasons, add ${y(2)} via Add Past Season (marking that season's doubled matchups among the current teams), then re-import.`,
    );
    expect(remedy).not.toContain(y(6));
  });

  it("offers retry for the fetch gap but marks an unreachable roster gap unrestorable", () => {
    const { remedy } = describeWithholdingGap(
      [y(1), y(6)],
      [{ season: y(1), error: "HTTP 502" }],
      [droppedSeason(y(6), 10)],
      detected,
    );
    expect(remedy).toBe(
      `Retrying may recover ${y(1)}, but ${y(6)} can't be restored (Add Past Season only reaches back to ${oldestOfferableYear}).`,
    );
  });

  it("returns empty cause and remedy when there are no gaps", () => {
    expect(describeWithholdingGap([], [], [], detected)).toEqual({
      cause: "",
      remedy: "",
    });
  });
});

describe("withholdingErrorMessage", () => {
  it("carries the cause and the same remedy guidance as the warning", () => {
    expect(
      withholdingErrorMessage("2025 failed to import", "Retry the import."),
    ).toBe(
      "2025 failed to import, and every season that did load is older - keeping them would leave a gap in season history, which corrupts recency-based avoidance. Retry the import.",
    );
  });
});

describe("withholdingWarningMessage", () => {
  it("uses singular phrasing for one withheld year", () => {
    expect(withholdingWarningMessage("C", "R.", ["2022"])).toBe(
      "C, so 2022 was withheld - a gap in season history corrupts recency-based avoidance. R.",
    );
  });

  it("uses plural phrasing for multiple withheld years", () => {
    expect(withholdingWarningMessage("C", "R.", ["2022", "2021"])).toBe(
      "C, so 2022, 2021 were withheld - a gap in season history corrupts recency-based avoidance. R.",
    );
  });
});

describe("yahooOAuthReturnPatch", () => {
  it("patches importSource alongside platform on the connected branch", () => {
    // The exact 582f234 regression: OAuth is a full-page redirect, so
    // importSource is back at "sleeper" - patching platform alone makes
    // the auto-load fetch's stale() guard discard its own response.
    expect(
      yahooOAuthReturnPatch(new URLSearchParams("yahoo=connected")),
    ).toEqual({
      platform: "yahoo",
      importSource: "yahoo",
      pendingYahooConnect: true,
    });
  });

  it("patches importSource alongside platform on the error branch", () => {
    const patch = yahooOAuthReturnPatch(
      new URLSearchParams("yahoo=error&reason=state_mismatch"),
    );
    expect(patch).toEqual({
      platform: "yahoo",
      importSource: "yahoo",
      importStatus: "error",
      importMsg: "Failed to connect to Yahoo Fantasy: state mismatch",
    });
  });

  it("keeps an Error-message reason's own punctuation", () => {
    const patch = yahooOAuthReturnPatch(
      new URLSearchParams({
        yahoo: "error",
        reason: "Token exchange failed (401).",
      }),
    );
    expect(patch?.importMsg).toBe(
      "Failed to connect to Yahoo Fantasy: Token exchange failed (401).",
    );
  });

  it("falls back to unknown when the reason is missing", () => {
    expect(
      yahooOAuthReturnPatch(new URLSearchParams("yahoo=error"))?.importMsg,
    ).toBe("Failed to connect to Yahoo Fantasy: unknown");
  });

  it("returns null without a yahoo param", () => {
    expect(yahooOAuthReturnPatch(new URLSearchParams(""))).toBeNull();
  });

  it("returns null for an unrecognized status", () => {
    expect(
      yahooOAuthReturnPatch(new URLSearchParams("yahoo=banana")),
    ).toBeNull();
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

describe("generateWithRetry", () => {
  const genFail: ScheduleResult = {
    ok: false,
    reason: "generation-failed",
    message: "Could not generate a schedule with these constraints.",
  };
  const success = { ok: true } as ScheduleResult;
  // Scripted attempt sequence; repeats the last entry if called again.
  function scripted(results: ScheduleResult[]) {
    let calls = 0;
    const attempt = () => {
      const r = results[Math.min(calls, results.length - 1)]!;
      calls++;
      return r;
    };
    return { attempt, callCount: () => calls };
  }
  const instantClock = () => 0;
  const noYield = () => Promise.resolve();

  it("yields once before a first-attempt success (the paint anchor)", async () => {
    // The yield precedes every attempt - including the first, so the
    // caller's "Generating…" patch can paint before generation blocks the
    // main thread.
    const { attempt, callCount } = scripted([success]);
    let yields = 0;
    const out = await generateWithRetry(attempt, 1000, 10, {
      now: instantClock,
      yieldToUi: () => {
        yields++;
        return Promise.resolve();
      },
    });
    expect(out).toEqual({ result: success, attempts: 1 });
    expect(callCount()).toBe(1);
    expect(yields).toBe(1);
  });

  it("retries generation-failed until success, yielding before each attempt", async () => {
    const { attempt } = scripted([genFail, genFail, success]);
    let yields = 0;
    const out = await generateWithRetry(attempt, 1000, 10, {
      now: instantClock,
      yieldToUi: () => {
        yields++;
        return Promise.resolve();
      },
    });
    expect(out).toEqual({ result: success, attempts: 3 });
    expect(yields).toBe(3);
  });

  it("stops at the attempt cap and returns the last failure", async () => {
    const { attempt, callCount } = scripted([genFail]);
    const out = await generateWithRetry(attempt, 1000, 5, {
      now: instantClock,
      yieldToUi: noYield,
    });
    expect(out).toEqual({ result: genFail, attempts: 5 });
    expect(callCount()).toBe(5);
  });

  it("stops when the wall-clock budget is spent", async () => {
    // Each attempt advances the fake clock 600ms; the budget admits exactly
    // one retry (check at 600 < 1000 passes, at 1200 fails).
    let t = 0;
    const clock = () => t;
    const attempt = () => {
      t += 600;
      return genFail;
    };
    const out = await generateWithRetry(attempt, 1000, 99, {
      now: clock,
      yieldToUi: noYield,
    });
    expect(out.attempts).toBe(2);
    expect(out.result).toEqual(genFail);
  });

  it("stops at the shouldStop signal instead of burning the budget", async () => {
    // A superseded run (Reset, Back-to-import, step navigation bumped the
    // run ref) must end at its next loop check, not 2.5s later.
    const { attempt, callCount } = scripted([genFail]);
    let stop = false;
    const out = await generateWithRetry(attempt, 1000, 10, {
      shouldStop: () => stop,
      now: instantClock,
      yieldToUi: () => {
        stop = true;
        return Promise.resolve();
      },
    });
    expect(out).toEqual({ result: genFail, attempts: 1 });
    expect(callCount()).toBe(1);
  });

  it("does not retry deterministic non-generation-failed results", async () => {
    const skip: ScheduleResult = {
      ok: false,
      reason: "pure-round-robin",
      message: "No fairness issue.",
      format: {} as never,
    };
    const invalid: ScheduleResult = {
      ok: false,
      reason: "invalid-format",
      message: "Bad shape.",
    };
    for (const result of [skip, invalid]) {
      const { attempt, callCount } = scripted([result]);
      const out = await generateWithRetry(attempt, 1000, 10, {
        now: instantClock,
        yieldToUi: noYield,
      });
      expect(out).toEqual({ result, attempts: 1 });
      expect(callCount()).toBe(1);
    }
  });
});

describe("generationFailureMessage", () => {
  it("passes through skip and invalid-format messages verbatim", () => {
    expect(
      generationFailureMessage(
        {
          ok: false,
          reason: "pure-round-robin",
          message: "No fairness issue.",
          format: {} as never,
        },
        false,
      ),
    ).toBe("No fairness issue.");
    expect(
      generationFailureMessage(
        { ok: false, reason: "invalid-format", message: "Bad shape." },
        true,
      ),
    ).toBe("Bad shape.");
  });

  it("passes through the algorithm's specific pin-validation messages", () => {
    const msg = "Invalid rivalry pin week: must be between 1 and 14.";
    expect(
      generationFailureMessage(
        { ok: false, reason: "generation-failed", message: msg },
        true,
      ),
    ).toBe(msg);
  });

  it("writes the post-retry copy for stochastic failures, by pin presence", () => {
    const failed: ScheduleResult = {
      ok: false,
      reason: "generation-failed",
      message: "Could not generate a schedule with these constraints.",
    };
    expect(generationFailureMessage(failed, true)).toBe(
      "Could not generate a valid schedule after several attempts. Try generating again or removing some rivalry pins.",
    );
    expect(generationFailureMessage(failed, false)).toBe(
      "Could not generate a valid schedule after several attempts. Try generating again, clearing some manual avoids, or shrinking the Lookback Window.",
    );
  });
});
