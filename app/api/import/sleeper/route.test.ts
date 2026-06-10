// Route-level coverage for the Sleeper import's partial-failure and
// all-failed response shapes, with the Sleeper API mocked at global fetch.
// No Redis env in tests, so rate limiting uses the in-memory fallback; each
// request gets a distinct IP so tests never share a bucket.

import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Routes Sleeper API paths (after the /v1 base) to canned responses.
function stubSleeperApi(routes: Record<string, () => Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace("https://api.sleeper.app/v1", "");
      const handler = routes[path];
      if (!handler) throw new Error(`Unexpected fetch: ${String(input)}`);
      return handler();
    }),
  );
}

let ipCounter = 0;
function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/import/sleeper?seasons=5", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.9.0.${++ipCounter}`,
    },
  });
}

// playoff_week_start: 2 keeps each season at one regular-season week so
// fetchSeason only pulls matchups/1.
function league(
  id: string,
  season: string,
  previous: string,
): Record<string, unknown> {
  return {
    league_id: id,
    name: `League ${season}`,
    season,
    previous_league_id: previous,
    settings: { playoff_week_start: 2 },
  };
}

const playedWeek = () =>
  jsonRes([
    { matchup_id: 1, roster_id: 1, points: 101.5 },
    { matchup_id: 1, roster_id: 2, points: 88.25 },
  ]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/import/sleeper", () => {
  it("returns { seasons, failed } on partial failure with failed[].season as the year label", async () => {
    stubSleeperApi({
      "/league/200": () => jsonRes(league("200", "2024", "100")),
      "/league/100": () => jsonRes(league("100", "2023", "0")),
      "/league/200/matchups/1": playedWeek,
      "/league/100/matchups/1": playedWeek,
      "/league/200/users": () =>
        jsonRes([
          { user_id: "u1", display_name: "Alice" },
          { user_id: "u2", display_name: "Bob" },
        ]),
      "/league/200/rosters": () =>
        jsonRes([
          { roster_id: 1, owner_id: "u1" },
          { roster_id: 2, owner_id: "u2" },
        ]),
      // The older season's fetch fails on both attempts.
      "/league/100/users": () => jsonRes({}, 500),
    });

    const res = await POST(postRequest({ leagueId: "200" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seasons: { seasonYear: string; teamNames: string[] }[];
      failed: { season: string; error: string }[];
    };

    expect(Array.isArray(body)).toBe(false);
    expect(body.seasons.map((s) => s.seasonYear)).toEqual(["2024"]);
    expect(body.seasons[0]!.teamNames).toEqual(["Alice", "Bob"]);
    expect(body.failed).toHaveLength(1);
    // The year label, never the leagueId: a numeric leagueId here would parse
    // as a huge year client-side and anchor withholding above everything.
    expect(body.failed[0]!.season).toBe("2023");
    expect(body.failed[0]!.error).toContain("HTTP 500");
  });

  it("returns the 502 shape when every season fails both attempts", async () => {
    stubSleeperApi({
      "/league/300": () => jsonRes(league("300", "2024", "0")),
      "/league/300/matchups/1": playedWeek,
      "/league/300/users": () => jsonRes({}, 500),
    });

    const res = await POST(postRequest({ leagueId: "300" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^Could not fetch any seasons from Sleeper\./);
    expect(body.error).toContain("2024:");
  });
});
