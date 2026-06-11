import { describe, expect, it } from "vitest";
import {
  buildStoredPayload,
  MAX_DOUBLE_KEY_LENGTH,
  MAX_HISTORY_ROWS,
  MAX_LEAGUE_NAME_LENGTH,
  MAX_PLATFORM_LENGTH,
  MAX_SEASON_LABEL_LENGTH,
  MAX_SEASON_YEAR,
  MAX_TEAM_NAME_LENGTH,
  MAX_USER_ID_LENGTH,
  MIN_SEASON_YEAR,
  validatePayload,
} from "./validate";

// A minimal valid payload: 4 teams, 3-week single round-robin.
function validPayload(): Record<string, unknown> {
  return {
    format: { teamCount: 4, weekCount: 3 },
    teams: ["Ali", "Ben", "Cal", "Dee"],
    userIds: [null, null, null, null],
    history: [],
    manualDoubles: [],
    schedule: {
      weeks: [
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
      ],
      doubledPairs: [],
    },
  };
}

function withSchedule(patch: Record<string, unknown>): Record<string, unknown> {
  const payload = validPayload();
  payload.schedule = {
    ...(payload.schedule as Record<string, unknown>),
    ...patch,
  };
  return payload;
}

describe("validatePayload", () => {
  describe("accepts", () => {
    it("a minimal valid payload", () => {
      expect(validatePayload(validPayload())).toBeNull();
    });

    it("empty team names", () => {
      const payload = validPayload();
      payload.teams = ["", "", "", ""];
      expect(validatePayload(payload)).toBeNull();
    });

    it("non-standard even round-robin shapes outside the 7 supported formats", () => {
      // 6 teams / 10 weeks (the 2*(n-1) upper bound) isn't a supported
      // format, but import auto-detection allows any even round-robin shape.
      const payload = validPayload();
      payload.format = { teamCount: 6, weekCount: 10 };
      payload.teams = ["A", "B", "C", "D", "E", "F"];
      payload.userIds = [null, null, null, null, null, null];
      payload.schedule = {
        weeks: Array.from({ length: 10 }, () => [
          [0, 1],
          [2, 3],
          [4, 5],
        ]),
        doubledPairs: [],
      };
      expect(validatePayload(payload)).toBeNull();
    });

    it("boundary-length names, optional fields, and a displayWeeks mirror", () => {
      const payload = validPayload();
      payload.teams = ["x".repeat(MAX_TEAM_NAME_LENGTH), "B", "C", "D"];
      payload.leagueName = "y".repeat(MAX_LEAGUE_NAME_LENGTH);
      payload.seasonYear = 2026;
      payload.platform = "sleeper";
      payload.rivalryPins = [{ teamA: 0, teamB: 1, week: null }];
      const schedule = payload.schedule as { weeks: unknown };
      payload.schedule = {
        weeks: schedule.weeks,
        doubledPairs: [],
        displayWeeks: schedule.weeks,
        rivalryPlacements: [
          { teamA: 0, teamB: 1, pinnedWeek: null, placedWeek: 2 },
        ],
      };
      expect(validatePayload(payload)).toBeNull();
    });
  });

  describe("body and format", () => {
    it("rejects non-object bodies", () => {
      expect(validatePayload(null)).toBe("Body must be an object.");
      expect(validatePayload([])).toBe("Body must be an object.");
      expect(validatePayload("{}")).toBe("Body must be an object.");
    });

    it("rejects a missing or malformed format", () => {
      expect(validatePayload({})).toBe("Missing format.");
      const payload = validPayload();
      payload.format = { teamCount: "4", weekCount: 3 };
      expect(validatePayload(payload)).toBe(
        "format.teamCount and format.weekCount must be integers.",
      );
      payload.format = { teamCount: 4, weekCount: 3.5 };
      expect(validatePayload(payload)).toBe(
        "format.teamCount and format.weekCount must be integers.",
      );
    });

    it("rejects odd, too-small, and oversized teamCount", () => {
      const expected =
        "format.teamCount must be an even integer between 2 and 32.";
      for (const teamCount of [5, 0, -2, 34]) {
        const payload = validPayload();
        payload.format = { teamCount, weekCount: 14 };
        expect(validatePayload(payload)).toBe(expected);
      }
    });

    it("rejects weekCount outside [teamCount - 1, 2 * (teamCount - 1)]", () => {
      const expected =
        "format.weekCount must be between teamCount - 1 and 2 * (teamCount - 1).";
      for (const weekCount of [2, 7]) {
        const payload = validPayload();
        payload.format = { teamCount: 4, weekCount };
        expect(validatePayload(payload)).toBe(expected);
      }
    });
  });

  describe("teams and optional scalars", () => {
    it("rejects a teams/teamCount length mismatch", () => {
      const payload = validPayload();
      payload.teams = ["Ali", "Ben", "Cal"];
      expect(validatePayload(payload)).toBe(
        "teams length must match format.teamCount.",
      );
    });

    it("rejects non-string and over-length team names", () => {
      const expected = `teams must be strings of at most ${MAX_TEAM_NAME_LENGTH} characters.`;
      const payload = validPayload();
      payload.teams = ["Ali", 2, "Cal", "Dee"];
      expect(validatePayload(payload)).toBe(expected);
      payload.teams = ["x".repeat(MAX_TEAM_NAME_LENGTH + 1), "B", "C", "D"];
      expect(validatePayload(payload)).toBe(expected);
    });

    it("rejects a non-string or over-length leagueName", () => {
      const expected = `leagueName must be a string of at most ${MAX_LEAGUE_NAME_LENGTH} characters when provided.`;
      const payload = validPayload();
      payload.leagueName = 7;
      expect(validatePayload(payload)).toBe(expected);
      payload.leagueName = "y".repeat(MAX_LEAGUE_NAME_LENGTH + 1);
      expect(validatePayload(payload)).toBe(expected);
    });

    it("rejects a non-integer or out-of-range seasonYear", () => {
      const expected = `seasonYear must be an integer between ${MIN_SEASON_YEAR} and ${MAX_SEASON_YEAR} when provided.`;
      const payload = validPayload();
      payload.seasonYear = "2026";
      expect(validatePayload(payload)).toBe(expected);
      payload.seasonYear = MIN_SEASON_YEAR - 1;
      expect(validatePayload(payload)).toBe(expected);
      payload.seasonYear = MAX_SEASON_YEAR + 1;
      expect(validatePayload(payload)).toBe(expected);
      // Number.isInteger(1e300) is true - the range check is what blocks it.
      payload.seasonYear = 1e300;
      expect(validatePayload(payload)).toBe(expected);
    });

    it("rejects a non-string or over-length platform", () => {
      const expected = `platform must be a string of at most ${MAX_PLATFORM_LENGTH} characters when provided.`;
      const payload = validPayload();
      payload.platform = 1;
      expect(validatePayload(payload)).toBe(expected);
      payload.platform = "x".repeat(MAX_PLATFORM_LENGTH + 1);
      expect(validatePayload(payload)).toBe(expected);
    });

    it("rejects non-array userIds, history, and manualDoubles", () => {
      for (const [field, message] of [
        ["userIds", "userIds must be an array."],
        ["history", "history must be an array."],
        ["manualDoubles", "manualDoubles must be an array."],
      ] as const) {
        const payload = validPayload();
        payload[field] = {};
        expect(validatePayload(payload)).toBe(message);
      }
    });
  });

  describe("rivalryPins", () => {
    it("rejects a non-array rivalryPins", () => {
      const payload = validPayload();
      payload.rivalryPins = {};
      expect(validatePayload(payload)).toBe(
        "rivalryPins must be an array when provided.",
      );
    });

    it("rejects pins without integer team indices", () => {
      const payload = validPayload();
      payload.rivalryPins = [{ teamA: 0.5, teamB: 1, week: null }];
      expect(validatePayload(payload)).toBe(
        "Each rivalry pin must have integer teamA and teamB.",
      );
      payload.rivalryPins = ["pin"];
      expect(validatePayload(payload)).toBe(
        "Each rivalry pin must be an object.",
      );
    });

    it("rejects a pin week that is neither null nor an in-range integer", () => {
      const expected =
        "rivalryPin.week must be null or an integer between 1 and format.weekCount.";
      for (const week of ["3", 0, 4, 2.5]) {
        const payload = validPayload();
        payload.rivalryPins = [{ teamA: 0, teamB: 1, week }];
        expect(validatePayload(payload)).toBe(expected);
      }
    });

    it("rejects out-of-range or identical pin team indices", () => {
      const expected =
        "Rivalry pin team indices must be distinct and in [0, teamCount).";
      for (const pin of [
        { teamA: 5000, teamB: 1, week: null },
        { teamA: 0, teamB: -1, week: null },
        { teamA: 2, teamB: 2, week: null },
      ]) {
        const payload = validPayload();
        payload.rivalryPins = [pin];
        expect(validatePayload(payload)).toBe(expected);
      }
    });
  });

  describe("userIds, history, and manualDoubles contents", () => {
    it("rejects a userIds/teamCount length mismatch", () => {
      const payload = validPayload();
      payload.userIds = [null, null, null];
      expect(validatePayload(payload)).toBe(
        "userIds length must match format.teamCount.",
      );
    });

    it("rejects userIds entries that are neither null nor short strings", () => {
      const expected = `userIds must be null or strings of at most ${MAX_USER_ID_LENGTH} characters.`;
      for (const bad of [7, {}, "x".repeat(MAX_USER_ID_LENGTH + 1)]) {
        const payload = validPayload();
        payload.userIds = [bad, null, null, null];
        expect(validatePayload(payload)).toBe(expected);
      }
    });

    it("accepts well-formed history rows of both formats", () => {
      const payload = validPayload();
      payload.userIds = ["u1", "u2", "u3", "u4"];
      payload.history = [
        { season: "2023", doubles: ["u1:u2"], format: "userid" },
        { season: "2024", doubles: ["0-1", "2-3"], format: "index" },
        // format omitted: rows from older payloads being re-shared are
        // treated as index format by the client.
        { season: "2025", doubles: ["1-2"] },
      ];
      expect(validatePayload(payload)).toBeNull();
    });

    it("rejects history rows that are not objects or lack a season label", () => {
      const payload = validPayload();
      payload.history = [null];
      expect(validatePayload(payload)).toBe(
        "Each history row must be an object.",
      );
      payload.history = [{ doubles: [], format: "index" }];
      expect(validatePayload(payload)).toBe(
        `history.season must be a string of at most ${MAX_SEASON_LABEL_LENGTH} characters.`,
      );
    });

    it("rejects unknown history formats and non-array doubles", () => {
      const payload = validPayload();
      payload.history = [{ season: "2024", doubles: [], format: "names" }];
      expect(validatePayload(payload)).toBe(
        'history.format must be "userid" or "index" when provided.',
      );
      payload.history = [{ season: "2024", doubles: "x", format: "index" }];
      expect(validatePayload(payload)).toBe(
        "history.doubles must be an array.",
      );
    });

    it("rejects out-of-range index-format history doubles", () => {
      const expected =
        'Each index-format double must be "i-j" with i < j < teamCount.';
      for (const key of ["999-999", "0-4", "1-0", "0:1", 7]) {
        const payload = validPayload();
        payload.history = [{ season: "2024", doubles: [key], format: "index" }];
        expect(validatePayload(payload)).toBe(expected);
      }
    });

    it("rejects malformed userid-format history doubles", () => {
      const expected = 'Each userid-format double must be an "idA:idB" string.';
      for (const key of ["0-1", 7, "x".repeat(MAX_DOUBLE_KEY_LENGTH + 1)]) {
        const payload = validPayload();
        payload.history = [
          { season: "2024", doubles: [key], format: "userid" },
        ];
        expect(validatePayload(payload)).toBe(expected);
      }
    });

    it("rejects manualDoubles outside the roster", () => {
      const expected =
        'Each manual double must be "i-j" with i < j < teamCount.';
      for (const key of ["999-999", "0-4", null]) {
        const payload = validPayload();
        payload.manualDoubles = [key];
        expect(validatePayload(payload)).toBe(expected);
      }
    });
  });

  describe("schedule weeks", () => {
    it("rejects a missing schedule and non-array weeks", () => {
      const payload = validPayload();
      delete payload.schedule;
      expect(validatePayload(payload)).toBe("Missing schedule.");
      expect(validatePayload(withSchedule({ weeks: {} }))).toBe(
        "schedule.weeks must be an array.",
      );
    });

    it("rejects a weeks/weekCount length mismatch", () => {
      const weeks = (validPayload().schedule as { weeks: unknown[] }).weeks;
      expect(validatePayload(withSchedule({ weeks: weeks.slice(0, 2) }))).toBe(
        "schedule.weeks length must match format.weekCount.",
      );
    });

    it("rejects a week entry that is not an array", () => {
      expect(
        validatePayload(withSchedule({ weeks: ["week one", [], []] })),
      ).toBe("Each schedule.weeks entry must be an array.");
    });

    it("rejects malformed matchup pairs", () => {
      const expected =
        "Each schedule.weeks matchup must be [int, int] with team indices in [0, teamCount).";
      for (const pair of [[0], [0, 1, 2], [0, 1.5], [0, "1"], "0-1"]) {
        expect(validatePayload(withSchedule({ weeks: [[pair], [], []] }))).toBe(
          expected,
        );
      }
    });

    it("rejects team indices outside [0, teamCount)", () => {
      const expected =
        "Each schedule.weeks matchup must be [int, int] with team indices in [0, teamCount).";
      expect(validatePayload(withSchedule({ weeks: [[[0, 4]], [], []] }))).toBe(
        expected,
      );
      expect(
        validatePayload(withSchedule({ weeks: [[[-1, 2]], [], []] })),
      ).toBe(expected);
    });

    it("rejects non-array doubledPairs", () => {
      expect(validatePayload(withSchedule({ doubledPairs: "0-1" }))).toBe(
        "schedule.doubledPairs must be an array.",
      );
    });
  });

  describe("displayWeeks and rivalryPlacements", () => {
    it("rejects displayWeeks that do not mirror the week count", () => {
      expect(validatePayload(withSchedule({ displayWeeks: [[], []] }))).toBe(
        "schedule.displayWeeks length must match format.weekCount.",
      );
      expect(validatePayload(withSchedule({ displayWeeks: {} }))).toBe(
        "schedule.displayWeeks must be an array when provided.",
      );
    });

    it("validates displayWeeks pairs like schedule.weeks", () => {
      expect(
        validatePayload(withSchedule({ displayWeeks: [[[0, 4]], [], []] })),
      ).toBe(
        "Each schedule.displayWeeks matchup must be [int, int] with team indices in [0, teamCount).",
      );
    });

    it("rejects malformed rivalryPlacements", () => {
      expect(validatePayload(withSchedule({ rivalryPlacements: {} }))).toBe(
        "schedule.rivalryPlacements must be an array when provided.",
      );
      expect(
        validatePayload(
          withSchedule({
            rivalryPlacements: [{ teamA: 0, teamB: 1, pinnedWeek: null }],
          }),
        ),
      ).toBe(
        "Each rivalry placement must have integer teamA, teamB, placedWeek.",
      );
      expect(
        validatePayload(
          withSchedule({
            rivalryPlacements: [
              { teamA: 0, teamB: 1, pinnedWeek: "2", placedWeek: 2 },
            ],
          }),
        ),
      ).toBe(
        "rivalryPlacement.pinnedWeek must be null or an integer between 1 and format.weekCount.",
      );
      expect(
        validatePayload(
          withSchedule({
            rivalryPlacements: [
              { teamA: 0, teamB: 1, pinnedWeek: null, placedWeek: 9 },
            ],
          }),
        ),
      ).toBe(
        "rivalryPlacement.placedWeek must be between 1 and format.weekCount.",
      );
    });

    it("rejects out-of-range or identical placement team indices", () => {
      // Same bounds treatment as rivalryPins - placements come from the
      // algorithm and are always in range, so nothing legitimate is blocked.
      expect(
        validatePayload(
          withSchedule({
            rivalryPlacements: [
              { teamA: 0, teamB: 5, pinnedWeek: null, placedWeek: 2 },
            ],
          }),
        ),
      ).toBe(
        "Rivalry placement team indices must be distinct and in [0, teamCount).",
      );
      expect(
        validatePayload(
          withSchedule({
            rivalryPlacements: [
              { teamA: 1, teamB: 1, pinnedWeek: null, placedWeek: 2 },
            ],
          }),
        ),
      ).toBe(
        "Rivalry placement team indices must be distinct and in [0, teamCount).",
      );
    });
  });

  describe("schedule repeat lists and clean flag", () => {
    it("accepts valid softRepeated/hardRepeated/clean and tolerates their absence", () => {
      expect(
        validatePayload(
          withSchedule({
            softRepeated: ["0-1"],
            hardRepeated: ["2-3"],
            clean: false,
          }),
        ),
      ).toBeNull();
      // The minimal payload omits all three.
      expect(validatePayload(validPayload())).toBeNull();
    });

    it("rejects non-array repeat lists and out-of-range repeat keys", () => {
      expect(validatePayload(withSchedule({ softRepeated: {} }))).toBe(
        "schedule.softRepeated must be an array when provided.",
      );
      expect(validatePayload(withSchedule({ softRepeated: ["0-9"] }))).toBe(
        'Each schedule.softRepeated entry must be "i-j" with i < j < teamCount.',
      );
      expect(validatePayload(withSchedule({ hardRepeated: [{}] }))).toBe(
        'Each schedule.hardRepeated entry must be "i-j" with i < j < teamCount.',
      );
    });

    it("rejects a non-boolean clean flag", () => {
      expect(validatePayload(withSchedule({ clean: "yes" }))).toBe(
        "schedule.clean must be a boolean when provided.",
      );
    });
  });

  // Count caps: every entry is individually valid, so only the cap rejects.
  // The real client can't exceed any of these (sets can't hold duplicate
  // pair keys, schedules are perfect matchings, the pin UI enforces tighter
  // per-team/per-week limits) - the caps exist for hand-crafted payloads.
  describe("count caps", () => {
    // For the 4-team payload: C(4,2) = 6 pairs, 2 matchups per week.
    const allPairs = ["0-1", "0-2", "0-3", "1-2", "1-3", "2-3"];
    const pinsAtCap = allPairs.flatMap((key) => {
      const [i, j] = key.split("-").map(Number);
      return [
        { teamA: i, teamB: j, week: null },
        { teamA: i, teamB: j, week: 1 },
      ];
    });

    it("accepts a payload at every count cap", () => {
      const payload = validPayload();
      payload.platform = "x".repeat(MAX_PLATFORM_LENGTH);
      payload.seasonYear = MAX_SEASON_YEAR;
      payload.history = Array.from({ length: MAX_HISTORY_ROWS }, (_, i) => ({
        season: String(1926 + i),
        doubles: [],
      }));
      payload.manualDoubles = allPairs;
      payload.rivalryPins = pinsAtCap;
      payload.schedule = {
        ...(payload.schedule as Record<string, unknown>),
        doubledPairs: allPairs,
        softRepeated: allPairs,
        hardRepeated: allPairs,
        rivalryPlacements: pinsAtCap.map((p) => ({
          teamA: p.teamA,
          teamB: p.teamB,
          pinnedWeek: p.week,
          placedWeek: 1,
        })),
      };
      expect(validatePayload(payload)).toBeNull();
    });

    it("rejects history with more rows than the cap", () => {
      const payload = validPayload();
      payload.history = Array.from(
        { length: MAX_HISTORY_ROWS + 1 },
        (_, i) => ({ season: String(1925 + i), doubles: [] }),
      );
      expect(validatePayload(payload)).toBe(
        `history must have at most ${MAX_HISTORY_ROWS} rows.`,
      );
    });

    it("rejects duplicate-spam in manualDoubles past the pair count", () => {
      const payload = validPayload();
      payload.manualDoubles = [...allPairs, "0-1"];
      expect(validatePayload(payload)).toBe(
        "manualDoubles has more entries than the roster has pairs.",
      );
    });

    it("rejects rivalryPins past two per pair", () => {
      const payload = validPayload();
      payload.rivalryPins = [...pinsAtCap, { teamA: 0, teamB: 1, week: null }];
      expect(validatePayload(payload)).toBe(
        "rivalryPins has more entries than the roster's pairs can play (two per pair).",
      );
    });

    it("rejects a week with more matchups than teamCount / 2", () => {
      const weeks = (validPayload().schedule as { weeks: number[][][] }).weeks;
      weeks[0] = [
        [0, 1],
        [2, 3],
        [0, 2],
      ];
      expect(validatePayload(withSchedule({ weeks }))).toBe(
        "Each schedule.weeks entry must have at most teamCount / 2 matchups.",
      );
      expect(validatePayload(withSchedule({ displayWeeks: weeks }))).toBe(
        "Each schedule.displayWeeks entry must have at most teamCount / 2 matchups.",
      );
    });

    it("rejects duplicate-spam in doubledPairs and the repeat lists", () => {
      expect(
        validatePayload(withSchedule({ doubledPairs: [...allPairs, "0-1"] })),
      ).toBe(
        "schedule.doubledPairs has more entries than the roster has pairs.",
      );
      expect(
        validatePayload(withSchedule({ softRepeated: [...allPairs, "0-1"] })),
      ).toBe(
        "schedule.softRepeated has more entries than the roster has pairs.",
      );
      expect(
        validatePayload(withSchedule({ hardRepeated: [...allPairs, "0-1"] })),
      ).toBe(
        "schedule.hardRepeated has more entries than the roster has pairs.",
      );
    });

    it("rejects rivalryPlacements past two per pair", () => {
      const placements = [...pinsAtCap, { teamA: 0, teamB: 1, week: null }].map(
        (p) => ({
          teamA: p.teamA,
          teamB: p.teamB,
          pinnedWeek: p.week,
          placedWeek: 1,
        }),
      );
      expect(
        validatePayload(withSchedule({ rivalryPlacements: placements })),
      ).toBe(
        "schedule.rivalryPlacements has more entries than the roster's pairs can play (two per pair).",
      );
    });
  });
});

describe("buildStoredPayload", () => {
  it("strips rider keys from every nested object", () => {
    // validatePayload checks known keys without rejecting extras, so the
    // stored object must be rebuilt field-by-field or riders survive into
    // the GET response (and history-row riders into a restoring user's
    // localStorage).
    const payload = validPayload();
    payload.format = { teamCount: 4, weekCount: 3, rider: "x" };
    payload.history = [
      { season: "2025", doubles: ["0-1"], format: "index", rider: "x" },
    ];
    payload.rivalryPins = [{ teamA: 0, teamB: 1, week: null, rider: "x" }];
    payload.schedule = {
      ...(payload.schedule as Record<string, unknown>),
      rivalryPlacements: [
        { teamA: 0, teamB: 1, pinnedWeek: null, placedWeek: 2, rider: "x" },
      ],
    };
    expect(validatePayload(payload)).toBeNull();

    const stored = buildStoredPayload(payload);
    expect(stored.format).toEqual({ teamCount: 4, weekCount: 3 });
    expect(stored.history).toEqual([
      { season: "2025", doubles: ["0-1"], format: "index" },
    ]);
    expect(stored.rivalryPins).toEqual([{ teamA: 0, teamB: 1, week: null }]);
    expect(stored.schedule.rivalryPlacements).toEqual([
      { teamA: 0, teamB: 1, pinnedWeek: null, placedWeek: 2 },
    ]);
  });

  it("does not store schedule.format and keeps absent optionals absent", () => {
    const payload = validPayload();
    payload.schedule = {
      ...(payload.schedule as Record<string, unknown>),
      format: { teamCount: 4, weekCount: 3, separation: 1 },
    };
    const stored = buildStoredPayload(payload);
    expect("format" in stored.schedule).toBe(false);
    expect(stored.rivalryPins).toBeUndefined();
    expect(stored.schedule.rivalryPlacements).toBeUndefined();
    expect(stored.schedule.displayWeeks).toBeUndefined();
  });

  it("passes validated fields through unchanged", () => {
    const payload = validPayload();
    payload.leagueName = "My League";
    payload.seasonYear = 2026;
    payload.platform = "sleeper";
    const stored = buildStoredPayload(payload);
    expect(stored.teams).toEqual(payload.teams);
    expect(stored.userIds).toEqual(payload.userIds);
    expect(stored.leagueName).toBe("My League");
    expect(stored.seasonYear).toBe(2026);
    expect(stored.platform).toBe("sleeper");
    expect(stored.manualDoubles).toEqual([]);
    expect(stored.schedule.weeks).toEqual(
      (payload.schedule as Record<string, unknown>).weeks,
    );
  });
});
