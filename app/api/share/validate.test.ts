import { describe, expect, it } from "vitest";
import {
  MAX_DOUBLE_KEY_LENGTH,
  MAX_LEAGUE_NAME_LENGTH,
  MAX_SEASON_LABEL_LENGTH,
  MAX_TEAM_NAME_LENGTH,
  MAX_USER_ID_LENGTH,
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

    it("rejects a non-integer seasonYear", () => {
      const payload = validPayload();
      payload.seasonYear = "2026";
      expect(validatePayload(payload)).toBe(
        "seasonYear must be an integer when provided.",
      );
    });

    it("rejects a non-string platform", () => {
      const payload = validPayload();
      payload.platform = 1;
      expect(validatePayload(payload)).toBe(
        "platform must be a string when provided.",
      );
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
  });
});
