import { describe, expect, it } from "vitest";
import { settleSeasonFetches } from "./seasons";
import type { SeasonData, SeasonTarget } from "./seasons";

function target(season: string, leagueId: string): SeasonTarget {
  return {
    leagueId,
    name: `League ${season || leagueId}`,
    season,
    settings: { playoff_week_start: 15 },
  };
}

function data(label: string): SeasonData {
  return {
    teamNames: [`${label} A`, `${label} B`],
    userIds: [null, null],
    doubles: [],
    totalMatchups: 1,
    regWeeks: 14,
  };
}

// Builds a fetcher that fails the first `failures[leagueId]` calls for each
// target and succeeds afterwards, recording per-target call counts.
function flakyFetcher(failures: Record<string, number>) {
  const calls: Record<string, number> = {};
  const fetchOne = async (t: SeasonTarget): Promise<SeasonData> => {
    calls[t.leagueId] = (calls[t.leagueId] ?? 0) + 1;
    if ((failures[t.leagueId] ?? 0) >= calls[t.leagueId]!) {
      throw new Error(`HTTP 500 from league ${t.leagueId}`);
    }
    return data(t.leagueId);
  };
  return { fetchOne, calls };
}

describe("settleSeasonFetches", () => {
  it("passes through full success with no failed entries, in input order", async () => {
    const targets = [target("2025", "300"), target("2024", "200")];
    const { fetchOne, calls } = flakyFetcher({});

    const { results, failed, errors } = await settleSeasonFetches(
      targets,
      fetchOne,
    );

    expect(failed).toEqual([]);
    expect(errors).toEqual([]);
    expect(results.map((r) => r.seasonYear)).toEqual(["2025", "2024"]);
    expect(results[0]).toMatchObject({
      seasonName: "League 2025",
      teamNames: ["300 A", "300 B"],
      regWeeks: 14,
    });
    expect(calls).toEqual({ "300": 1, "200": 1 });
  });

  it("recovers a first-attempt failure via the single retry with no failed entry", async () => {
    const targets = [target("2025", "300"), target("2024", "200")];
    const { fetchOne, calls } = flakyFetcher({ "200": 1 });

    const { results, failed } = await settleSeasonFetches(targets, fetchOne);

    expect(failed).toEqual([]);
    // The retried season lands back at its original position.
    expect(results.map((r) => r.seasonYear)).toEqual(["2025", "2024"]);
    // Only the rejected season is re-fetched; successes aren't.
    expect(calls).toEqual({ "300": 1, "200": 2 });
  });

  it("reports a both-attempts failure under the year label, never the leagueId", async () => {
    // Pin the near-miss: a numeric leagueId in failed[].season would parse as
    // a huge year on the client and anchor gap-withholding above everything.
    const targets = [
      target("2024", "987654321098765432"),
      target("2023", "100"),
    ];
    const { fetchOne, calls } = flakyFetcher({ "987654321098765432": 2 });

    const { results, failed, errors } = await settleSeasonFetches(
      targets,
      fetchOne,
    );

    expect(results.map((r) => r.seasonYear)).toEqual(["2023"]);
    expect(failed).toEqual([
      {
        season: "2024",
        error: "HTTP 500 from league 987654321098765432",
      },
    ]);
    expect(failed[0]!.season).not.toBe("987654321098765432");
    expect(errors).toEqual(["2024: HTTP 500 from league 987654321098765432"]);
    expect(calls["987654321098765432"]).toBe(2);
  });

  it("keeps failed[].season as the (empty) year label and only the error message falls back to leagueId", async () => {
    const targets = [target("", "555"), target("2024", "200")];
    const { fetchOne } = flakyFetcher({ "555": 2 });

    const { failed, errors } = await settleSeasonFetches(targets, fetchOne);

    expect(failed).toEqual([{ season: "", error: "HTTP 500 from league 555" }]);
    expect(errors).toEqual(["555: HTTP 500 from league 555"]);
  });

  it("returns empty results with every season failed when nothing succeeds", async () => {
    const targets = [target("2025", "300"), target("2024", "200")];
    const { fetchOne, calls } = flakyFetcher({ "300": 2, "200": 2 });

    const { results, failed, errors } = await settleSeasonFetches(
      targets,
      fetchOne,
    );

    expect(results).toEqual([]);
    expect(failed.map((f) => f.season)).toEqual(["2025", "2024"]);
    expect(errors).toHaveLength(2);
    expect(calls).toEqual({ "300": 2, "200": 2 });
  });

  it("normalizes non-Error rejection reasons", async () => {
    const targets = [target("2025", "300"), target("2024", "200")];
    const fetchOne = (t: SeasonTarget): Promise<SeasonData> =>
      t.leagueId === "300"
        ? Promise.reject("string reason")
        : Promise.reject({ code: 500 });

    const { failed } = await settleSeasonFetches(targets, fetchOne);

    expect(failed).toEqual([
      { season: "2025", error: "string reason" },
      { season: "2024", error: "unknown error" },
    ]);
  });
});
