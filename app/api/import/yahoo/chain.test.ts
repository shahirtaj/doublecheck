import { describe, expect, it } from "vitest";
import { walkSeasonChain } from "./chain";
import type {
  ChainDeps,
  ImportedSeasonRecord,
  YahooLeagueDetails,
} from "./chain";

function details(
  key: string,
  season: string,
  renew: string | null,
  overrides: Partial<YahooLeagueDetails> = {},
): YahooLeagueDetails {
  return {
    leagueKey: key,
    name: `League ${season}`,
    season,
    numTeams: 10,
    startWeek: 1,
    endWeek: 16,
    playoffStartWeek: 15,
    currentWeek: 16,
    isFinished: true,
    renew,
    ...overrides,
  };
}

function record(season: string): ImportedSeasonRecord {
  return {
    seasonYear: season,
    seasonName: `League ${season}`,
    teamNames: ["A", "B"],
    userIds: [null, null],
    doubles: [],
    totalMatchups: 14,
    regWeeks: 14,
  };
}

// Builds ChainDeps from scripted maps. fetchDetails: an Error throws, null
// simulates an unparseable response. fetchRecord: defaults to a record built
// from the season; an Error throws, null simulates a season yielding no
// usable record.
function depsFrom(
  detailsMap: Record<string, YahooLeagueDetails | null | Error>,
  recordMap: Record<string, ImportedSeasonRecord | null | Error> = {},
): ChainDeps {
  return {
    fetchDetails: async (key) => {
      const d = detailsMap[key];
      if (d === undefined) throw new Error(`no details scripted for ${key}`);
      if (d instanceof Error) throw d;
      return d;
    },
    fetchRecord: async (d) => {
      const r = recordMap[d.leagueKey];
      if (r instanceof Error) throw r;
      if (r !== undefined) return r;
      return record(d.season);
    },
  };
}

const THREE_SEASON_CHAIN = {
  "nfl.l.3": details("nfl.l.3", "2025", "nfl.l.2"),
  "nfl.l.2": details("nfl.l.2", "2024", "nfl.l.1"),
  "nfl.l.1": details("nfl.l.1", "2023", null),
};

describe("walkSeasonChain", () => {
  it("walks the full renew chain newest-first", async () => {
    const records = await walkSeasonChain(
      "nfl.l.3",
      5,
      depsFrom(THREE_SEASON_CHAIN),
    );
    expect(records.map((r) => r.seasonYear)).toEqual(["2025", "2024", "2023"]);
  });

  it("caps the walk at seasonsCount", async () => {
    const records = await walkSeasonChain(
      "nfl.l.3",
      2,
      depsFrom(THREE_SEASON_CHAIN),
    );
    expect(records.map((r) => r.seasonYear)).toEqual(["2025", "2024"]);
  });

  it("skips an unfinished season but keeps walking its renew pointer", async () => {
    const records = await walkSeasonChain(
      "nfl.l.3",
      5,
      depsFrom({
        ...THREE_SEASON_CHAIN,
        "nfl.l.3": details("nfl.l.3", "2025", "nfl.l.2", { isFinished: false }),
      }),
    );
    expect(records.map((r) => r.seasonYear)).toEqual(["2024", "2023"]);
  });

  it("counts every visited link against the depth cap, finished or not", async () => {
    const records = await walkSeasonChain(
      "nfl.l.3",
      2,
      depsFrom({
        ...THREE_SEASON_CHAIN,
        "nfl.l.3": details("nfl.l.3", "2025", "nfl.l.2", { isFinished: false }),
      }),
    );
    // The unfinished 2025 link consumed one of the two depth slots.
    expect(records.map((r) => r.seasonYear)).toEqual(["2024"]);
  });

  it("stops on a mid-chain details fetch error and returns the contiguous newer run", async () => {
    const records = await walkSeasonChain(
      "nfl.l.3",
      5,
      depsFrom({
        ...THREE_SEASON_CHAIN,
        "nfl.l.2": new Error("HTTP 500"),
      }),
    );
    expect(records.map((r) => r.seasonYear)).toEqual(["2025"]);
  });

  it("stops on mid-chain unparseable details and returns the contiguous newer run", async () => {
    const records = await walkSeasonChain(
      "nfl.l.3",
      5,
      depsFrom({ ...THREE_SEASON_CHAIN, "nfl.l.2": null }),
    );
    expect(records.map((r) => r.seasonYear)).toEqual(["2025"]);
  });

  it("stops on a mid-chain record fetch error and returns the contiguous newer run", async () => {
    const records = await walkSeasonChain(
      "nfl.l.3",
      5,
      depsFrom(THREE_SEASON_CHAIN, { "nfl.l.2": new Error("HTTP 502") }),
    );
    expect(records.map((r) => r.seasonYear)).toEqual(["2025"]);
  });

  it("stops when a finished mid-chain season yields no record", async () => {
    const records = await walkSeasonChain(
      "nfl.l.3",
      5,
      depsFrom(THREE_SEASON_CHAIN, { "nfl.l.2": null }),
    );
    expect(records.map((r) => r.seasonYear)).toEqual(["2025"]);
  });

  it("propagates a first-link details failure", async () => {
    await expect(
      walkSeasonChain(
        "nfl.l.3",
        5,
        depsFrom({
          ...THREE_SEASON_CHAIN,
          "nfl.l.3": new Error("HTTP 500"),
        }),
      ),
    ).rejects.toThrow("HTTP 500");
  });

  it("propagates a first-link record failure", async () => {
    await expect(
      walkSeasonChain(
        "nfl.l.3",
        5,
        depsFrom(THREE_SEASON_CHAIN, {
          "nfl.l.3": new Error("HTTP 502"),
        }),
      ),
    ).rejects.toThrow("HTTP 502");
  });

  it("propagates UNAUTHORIZED even mid-chain with records already collected", async () => {
    await expect(
      walkSeasonChain(
        "nfl.l.3",
        5,
        depsFrom({
          ...THREE_SEASON_CHAIN,
          "nfl.l.2": new Error("UNAUTHORIZED"),
        }),
      ),
    ).rejects.toThrow("UNAUTHORIZED");

    await expect(
      walkSeasonChain(
        "nfl.l.3",
        5,
        depsFrom(THREE_SEASON_CHAIN, { "nfl.l.2": new Error("UNAUTHORIZED") }),
      ),
    ).rejects.toThrow("UNAUTHORIZED");
  });

  it("terminates on a renew cycle instead of looping", async () => {
    const records = await walkSeasonChain(
      "nfl.l.2",
      5,
      depsFrom({
        "nfl.l.2": details("nfl.l.2", "2024", "nfl.l.1"),
        "nfl.l.1": details("nfl.l.1", "2023", "nfl.l.2"),
      }),
    );
    expect(records.map((r) => r.seasonYear)).toEqual(["2024", "2023"]);
  });
});
