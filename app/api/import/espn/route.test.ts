// Route-level coverage for the ESPN import's failure shapes (private-league
// 403 with the current-season probe, cookie-path 401, all-failed 502) and
// the cookie forwarding, with ESPN mocked at global fetch. No Redis env in
// tests, so rate limiting uses the in-memory fallback; each request gets a
// distinct IP.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ESPN_S2_INVALID_MESSAGE } from "./cookies";
import { POST } from "./route";

const CURRENT_YEAR = new Date().getFullYear();
const COOKIE = `AEB${"x9Qz".repeat(60)}%2Bab%2Fcd%3D%3D`;

let ipCounter = 0;
function postRequest(body: unknown, seasons: number): Request {
  return new Request(`http://localhost/api/import/espn?seasons=${seasons}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.9.1.${++ipCounter}`,
    },
  });
}

function yearOf(url: string): number {
  return Number(/\/seasons\/(\d{4})\//.exec(url)![1]);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The live 401 body shape: the marker lives on the `details` objects, not
// in the `messages` strings.
function notVisible(status = 401): Response {
  return json(
    {
      messages: ["You are not authorized to view this League."],
      details: [
        {
          message: "You are not authorized to view this League.",
          type: "AUTH_LEAGUE_NOT_VISIBLE",
        },
      ],
    },
    status,
  );
}

// Minimal season body the route parses: 4 teams, a 3-week round robin.
function leagueBody(name = "Test League", isPublic = true) {
  const teams = [1, 2, 3, 4].map((id) => ({
    id,
    name: `Team ${id}`,
    primaryOwner: `{OWNER-${id}}`,
  }));
  const schedule = [
    [1, 2],
    [3, 4],
    [1, 3],
    [2, 4],
    [1, 4],
    [2, 3],
  ].map(([home, away], i) => ({
    matchupPeriodId: Math.floor(i / 2) + 1,
    playoffTierType: "NONE",
    home: { teamId: home },
    away: { teamId: away },
  }));
  return { teams, schedule, settings: { name, isPublic } };
}

type Init = { headers: Record<string, string>; cache?: string };
function stubFetch(handler: (url: string, init: Init) => Response) {
  const fetchMock = vi.fn(async (url: string, init: Init) =>
    handler(url, init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/import/espn - anonymous", () => {
  it("returns the private 403 after a denied current-season probe, without retries", async () => {
    const fetchMock = stubFetch(() => notVisible());

    const res = await POST(postRequest({ leagueId: "123" }, 3));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toBe(
      "This ESPN league is private. Import it with your espn_s2 cookie, or use Manual import.",
    );
    expect(body.code).toBe("private");
    // Deterministic private statuses are not retried: one call per season,
    // plus the settings-only probe of the current season.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const probe = fetchMock.mock.calls.find(
      ([url]) => yearOf(url) === CURRENT_YEAR,
    )!;
    expect(probe[0]).toContain("view=mSettings");
    expect(probe[0]).not.toContain("view=mTeam");
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers.Cookie).toBeUndefined();
    }
  });

  it("names the league and the year when the probe proves the toggle worked", async () => {
    // The request the client actually sends (?seasons=14) against a
    // formerly-private league: recent years 401, pre-creation years 404,
    // and the in-progress season public.
    const fetchMock = stubFetch((url) => {
      const year = yearOf(url);
      if (year === CURRENT_YEAR) {
        return json({
          settings: { name: "Show Me Your TD's FFL", isPublic: true },
        });
      }
      return year >= CURRENT_YEAR - 8 ? notVisible() : json({}, 404);
    });

    const res = await POST(postRequest({ leagueId: "517254" }, 14));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe("current-season-only");
    expect(body.error).toBe(
      `"Show Me Your TD's FFL" is public for ${CURRENT_YEAR} only - ESPN keeps its earlier seasons private, and those are the seasons DoubleCheck needs. Import them with your espn_s2 cookie, or use Manual import.`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(15);
  });

  it("falls back to the generic subject when the probe body has no name", async () => {
    stubFetch((url) =>
      yearOf(url) === CURRENT_YEAR
        ? json({ settings: { isPublic: true } })
        : notVisible(403),
    );

    const res = await POST(postRequest({ leagueId: "123" }, 2));
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(
      new RegExp(`^This ESPN league is public for ${CURRENT_YEAR} only - `),
    );
  });

  it("requires the explicit isPublic flag - a bare 200 probe is not proof", async () => {
    stubFetch((url) =>
      yearOf(url) === CURRENT_YEAR
        ? json({ settings: { name: "X", isPublic: false } })
        : notVisible(),
    );

    const res = await POST(postRequest({ leagueId: "123" }, 2));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("private");
  });

  it("skips the probe when the requested window already covers the current year", async () => {
    const fetchMock = stubFetch(() => notVisible());

    const res = await POST(
      postRequest({ leagueId: "123", seasonId: CURRENT_YEAR }, 2),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("private");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies a 200 body carrying the AUTH_LEAGUE_NOT_VISIBLE detail as private", async () => {
    const fetchMock = stubFetch(() => notVisible(200));

    const res = await POST(postRequest({ leagueId: "123" }, 2));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("private");
    // No retry: the body was classified, not treated as malformed.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns a definitive 404 without probing when every season is not found", async () => {
    const fetchMock = stubFetch(() => json({}, 404));

    const res = await POST(postRequest({ leagueId: "123" }, 3));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      'ESPN league "123" not found. Check the league ID.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns the 502 shape when every season fails transiently, after one retry each", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(postRequest({ leagueId: "123" }, 2));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^Could not fetch any seasons from ESPN\./);
    expect(body.error).toContain("Network error fetching season");
    // Transient failures get exactly two attempts per season.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("takes the season name from settings.name", async () => {
    const fetchMock = stubFetch(() => json(leagueBody("Dynasty of Dads")));

    const res = await POST(postRequest({ leagueId: "123" }, 1));
    expect(res.status).toBe(200);
    const seasons = (await res.json()) as { seasonName: string }[];
    expect(seasons[0]!.seasonName).toBe("Dynasty of Dads");
    expect(fetchMock.mock.calls[0]![0]).toContain("view=mSettings");
    expect(fetchMock.mock.calls[0]![1].cache).toBe("no-store");
  });
});

describe("POST /api/import/espn - with espn_s2", () => {
  it("forwards the cookie on every season fetch, never cached", async () => {
    const fetchMock = stubFetch(() => json(leagueBody()));

    const res = await POST(postRequest({ leagueId: "123", espnS2: COOKIE }, 3));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers.Cookie).toBe(`espn_s2=${COOKIE}`);
      expect(init.cache).toBe("no-store");
    }
  });

  it("returns the cookies-rejected 401 when every season is denied, without probing", async () => {
    const fetchMock = stubFetch(() => notVisible());

    const res = await POST(postRequest({ leagueId: "123", espnS2: COOKIE }, 3));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe("cookies-rejected");
    expect(body.error).toBe(
      "ESPN rejected the cookie for every season. Check that espn_s2 was copied completely, and that the signed-in ESPN account was in this league during those seasons.",
    );
    // The probe is an anonymous-path diagnosis; the cookie path skips it.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports seasons the account can't see in the partial shape", async () => {
    // Member since CURRENT_YEAR - 2: older years 401 even with a valid
    // cookie (a private league's pre-membership years are 401, not 404).
    stubFetch((url) =>
      yearOf(url) >= CURRENT_YEAR - 2 ? json(leagueBody()) : notVisible(),
    );

    const res = await POST(postRequest({ leagueId: "123", espnS2: COOKIE }, 4));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seasons: { seasonYear: string }[];
      failed: { season: string; error: string }[];
    };
    expect(body.seasons.map((s) => s.seasonYear)).toEqual([
      String(CURRENT_YEAR - 1),
      String(CURRENT_YEAR - 2),
    ]);
    expect(body.failed).toEqual([
      {
        season: String(CURRENT_YEAR - 3),
        error: `Season ${CURRENT_YEAR - 3} is not visible to this ESPN account.`,
      },
      {
        season: String(CURRENT_YEAR - 4),
        error: `Season ${CURRENT_YEAR - 4} is not visible to this ESPN account.`,
      },
    ]);
  });

  it("rejects a malformed cookie before touching ESPN", async () => {
    const fetchMock = stubFetch(() => json(leagueBody()));

    const res = await POST(
      postRequest({ leagueId: "123", espnS2: `${COOKIE}; SWID=` }, 2),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      ESPN_S2_INVALID_MESSAGE,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts the cookie from a fetch error that echoes the header", async () => {
    // Node's fetch echoes header values in its TypeErrors; the route must
    // not let the cookie through to the response body.
    const fetchMock = vi.fn(async () => {
      throw new TypeError(
        `Headers.append: "espn_s2=${COOKIE}" is an invalid header value (${COOKIE}).`,
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(postRequest({ leagueId: "123", espnS2: COOKIE }, 1));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain(COOKIE);
    expect(body.error).toContain(
      '"[cookie]" is an invalid header value ([cookie])',
    );
  });
});
