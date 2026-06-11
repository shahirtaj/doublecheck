import { describe, expect, it } from "vitest";
import { pairKey } from "@/lib/algorithm";
import type { YahooLeagueDetails } from "./chain";
import {
  buildLeagueKeyFromRenew,
  fetchSeasonRecord,
  flattenYahooMeta,
  parseLeagueDetails,
  parseLeaguesList,
  parseScoreboard,
  parseTeams,
  YAHOO_BASE,
} from "./parsers";

// Fixtures are hand-built to the shapes the parsers consume (real responses
// can't be checked in - capturing them needs an OAuth session and they carry
// account data). They pin OUR parsing behavior so refactors can't silently
// regress it; they cannot detect Yahoo changing its response shapes.

describe("flattenYahooMeta", () => {
  it("coalesces Yahoo's array-of-single-key-objects into one record", () => {
    expect(
      flattenYahooMeta([
        { league_key: "449.l.1" },
        { name: "Alpha" },
        { season: "2025" },
      ]),
    ).toEqual({ league_key: "449.l.1", name: "Alpha", season: "2025" });
  });

  it("recurses into nested arrays and lets later keys win", () => {
    expect(flattenYahooMeta([[{ a: 1 }], [{ b: 2 }, [{ a: 3 }]]])).toEqual({
      a: 3,
      b: 2,
    });
  });

  it("copies plain objects and returns {} for null/undefined/scalars", () => {
    expect(flattenYahooMeta({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(flattenYahooMeta(null)).toEqual({});
    expect(flattenYahooMeta(undefined)).toEqual({});
    expect(flattenYahooMeta("x")).toEqual({});
  });
});

describe("buildLeagueKeyFromRenew", () => {
  it("returns null for missing, empty, and Yahoo's '0' sentinel", () => {
    expect(buildLeagueKeyFromRenew(undefined)).toBeNull();
    expect(buildLeagueKeyFromRenew(null)).toBeNull();
    expect(buildLeagueKeyFromRenew("")).toBeNull();
    expect(buildLeagueKeyFromRenew("0")).toBeNull();
    expect(buildLeagueKeyFromRenew(449)).toBeNull();
  });

  it("passes through an already-formed league key", () => {
    expect(buildLeagueKeyFromRenew("449.l.123")).toBe("449.l.123");
  });

  it("converts the renew 'gameKey_leagueId' form", () => {
    expect(buildLeagueKeyFromRenew("423_98765")).toBe("423.l.98765");
  });

  it("returns null for unrecognized forms", () => {
    expect(buildLeagueKeyFromRenew("garbage")).toBeNull();
    expect(buildLeagueKeyFromRenew("_123")).toBeNull();
  });
});

// Builds the users→games→leagues nesting the leagues-list endpoint returns.
function leaguesListJson(
  games: Array<Array<Record<string, unknown>>>,
): unknown {
  const gamesObj: Record<string, unknown> = { count: games.length };
  games.forEach((leagues, g) => {
    const leaguesObj: Record<string, unknown> = { count: leagues.length };
    leagues.forEach((meta, l) => {
      leaguesObj[String(l)] = {
        league: [Object.entries(meta).map(([k, v]) => ({ [k]: v }))],
      };
    });
    gamesObj[String(g)] = { game: [{}, { leagues: leaguesObj }] };
  });
  return {
    fantasy_content: { users: { "0": { user: [{}, { games: gamesObj }] } } },
  };
}

describe("parseLeaguesList", () => {
  it("collects leagues across games, keeping one entry per name (newest season)", () => {
    const json = leaguesListJson([
      [
        { league_key: "423.l.1", name: "Alpha", season: "2023", num_teams: 10 },
        { league_key: "423.l.2", name: "Beta", season: "2023", num_teams: 12 },
      ],
      [{ league_key: "449.l.1", name: "Alpha", season: "2025", num_teams: 10 }],
    ]);
    expect(parseLeaguesList(json)).toEqual([
      { leagueKey: "449.l.1", name: "Alpha", season: "2025", numTeams: 10 },
      { leagueKey: "423.l.2", name: "Beta", season: "2023", numTeams: 12 },
    ]);
  });

  it("sorts by season descending, then name ascending with numeric compare", () => {
    const json = leaguesListJson([
      [
        { league_key: "449.l.1", name: "League 10", season: "2025" },
        { league_key: "449.l.2", name: "League 2", season: "2025" },
        { league_key: "423.l.3", name: "Old", season: "2023" },
      ],
    ]);
    expect(parseLeaguesList(json).map((l) => l.name)).toEqual([
      "League 2",
      "League 10",
      "Old",
    ]);
  });

  it("skips leagues without a league_key and tolerates malformed roots", () => {
    const json = leaguesListJson([[{ name: "No key", season: "2025" }]]);
    expect(parseLeaguesList(json)).toEqual([]);
    expect(parseLeaguesList(undefined)).toEqual([]);
    expect(parseLeaguesList({})).toEqual([]);
    expect(parseLeaguesList({ fantasy_content: { users: {} } })).toEqual([]);
  });
});

// Builds the league;out=settings response shape.
function leagueDetailsJson(
  meta: Record<string, unknown>,
  settings?: unknown,
): unknown {
  const metaArr = Object.entries(meta).map(([k, v]) => ({ [k]: v }));
  const league: unknown[] = [metaArr];
  if (settings !== undefined) league.push({ settings });
  return { fantasy_content: { league } };
}

describe("parseLeagueDetails", () => {
  const baseMeta = {
    league_key: "449.l.123",
    name: "Alpha",
    season: "2025",
    num_teams: "10",
    start_week: "1",
    end_week: "16",
    playoff_start_week: "15",
    current_week: "16",
    is_finished: 1,
    renew: "423_98765",
  };

  it("parses metadata, coerces numerics, and converts the renew pointer", () => {
    expect(parseLeagueDetails(leagueDetailsJson(baseMeta))).toEqual({
      leagueKey: "449.l.123",
      name: "Alpha",
      season: "2025",
      numTeams: 10,
      startWeek: 1,
      endWeek: 16,
      playoffStartWeek: 15,
      currentWeek: 16,
      isFinished: true,
      renew: "423.l.98765",
    });
  });

  it("prefers the settings playoff_start_week (array and object forms)", () => {
    const fromArray = parseLeagueDetails(
      leagueDetailsJson(baseMeta, [{ playoff_start_week: "14" }]),
    );
    expect(fromArray?.playoffStartWeek).toBe(14);
    const fromObject = parseLeagueDetails(
      leagueDetailsJson(baseMeta, { playoff_start_week: "14" }),
    );
    expect(fromObject?.playoffStartWeek).toBe(14);
    // A 0 in settings keeps the meta value.
    const zero = parseLeagueDetails(
      leagueDetailsJson(baseMeta, { playoff_start_week: 0 }),
    );
    expect(zero?.playoffStartWeek).toBe(15);
  });

  it("defaults startWeek to 1 and treats unfinished flags as false", () => {
    const meta = { ...baseMeta };
    delete (meta as Record<string, unknown>).start_week;
    const details = parseLeagueDetails(
      leagueDetailsJson({ ...meta, is_finished: 0, renew: "0" }),
    );
    expect(details?.startWeek).toBe(1);
    expect(details?.isFinished).toBe(false);
    expect(details?.renew).toBeNull();
  });

  it("returns null for malformed roots and a missing league_key", () => {
    expect(parseLeagueDetails(undefined)).toBeNull();
    expect(parseLeagueDetails({ fantasy_content: {} })).toBeNull();
    expect(
      parseLeagueDetails(leagueDetailsJson({ name: "No key" })),
    ).toBeNull();
  });
});

// Builds the league/teams response shape. Each entry's meta rides as the
// first element of the team array, mirroring Yahoo's [metaArray, stats] form.
function teamsJson(teams: Array<Record<string, unknown>>): unknown {
  const teamsObj: Record<string, unknown> = { count: teams.length };
  teams.forEach((meta, i) => {
    teamsObj[String(i)] = {
      team: [Object.entries(meta).map(([k, v]) => ({ [k]: v }))],
    };
  });
  return { fantasy_content: { league: [{}, { teams: teamsObj }] } };
}

function teamMeta(
  id: number,
  name: string,
  guid?: string,
): Record<string, unknown> {
  return {
    team_key: `449.l.123.t.${id}`,
    team_id: String(id),
    name,
    ...(guid ? { managers: [{ manager: { guid } }] } : {}),
  };
}

describe("parseTeams", () => {
  it("parses ids, names, and manager guids; guid defaults to null", () => {
    const json = teamsJson([
      teamMeta(1, "Aardvarks", "GUIDA"),
      teamMeta(2, "Bears"),
    ]);
    expect(parseTeams(json)).toEqual([
      {
        teamKey: "449.l.123.t.1",
        teamId: 1,
        name: "Aardvarks",
        managerGuid: "GUIDA",
      },
      { teamKey: "449.l.123.t.2", teamId: 2, name: "Bears", managerGuid: null },
    ]);
  });

  it("skips entries missing a team_key or numeric team_id", () => {
    const noId = teamMeta(1, "NoId");
    delete noId.team_id;
    const noKey = teamMeta(2, "NoKey");
    delete noKey.team_key;
    const json = teamsJson([noId, noKey, teamMeta(3, "Kept")]);
    expect(parseTeams(json).map((t) => t.name)).toEqual(["Kept"]);
  });

  it("returns [] for malformed roots", () => {
    expect(parseTeams(undefined)).toEqual([]);
    expect(parseTeams({ fantasy_content: { league: [{}] } })).toEqual([]);
  });
});

// Builds the league/scoreboard response shape: matchups keyed by index, each
// holding week/is_playoffs meta plus a "0".teams holder of two team arrays.
function scoreboardJson(
  matchups: Array<{ week: unknown; isPlayoffs?: unknown; teamIds: number[] }>,
): unknown {
  const matchupsObj: Record<string, unknown> = { count: matchups.length };
  matchups.forEach((m, i) => {
    const teamsObj: Record<string, unknown> = { count: m.teamIds.length };
    m.teamIds.forEach((id, t) => {
      teamsObj[String(t)] = { team: [[{ team_id: String(id) }]] };
    });
    matchupsObj[String(i)] = {
      matchup: {
        week: m.week,
        ...(m.isPlayoffs !== undefined ? { is_playoffs: m.isPlayoffs } : {}),
        "0": { teams: teamsObj },
      },
    };
  });
  return {
    fantasy_content: {
      league: [{}, { scoreboard: { "0": { matchups: matchupsObj } } }],
    },
  };
}

describe("parseScoreboard", () => {
  it("parses weeks, playoff flags, and team id pairs", () => {
    const json = scoreboardJson([
      { week: "1", isPlayoffs: "0", teamIds: [1, 2] },
      { week: "15", isPlayoffs: "1", teamIds: [3, 4] },
    ]);
    expect(parseScoreboard(json)).toEqual([
      { week: 1, isPlayoffs: false, teamIds: [1, 2] },
      { week: 15, isPlayoffs: true, teamIds: [3, 4] },
    ]);
  });

  it("skips matchups without a numeric week or exactly two teams", () => {
    const json = scoreboardJson([
      { week: "x", teamIds: [1, 2] },
      { week: "2", teamIds: [3] },
      { week: "3", teamIds: [5, 6] },
    ]);
    expect(parseScoreboard(json)).toEqual([
      { week: 3, isPlayoffs: false, teamIds: [5, 6] },
    ]);
  });

  it("returns [] for malformed roots", () => {
    expect(parseScoreboard(undefined)).toEqual([]);
    expect(parseScoreboard({ fantasy_content: { league: [{}] } })).toEqual([]);
  });
});

describe("fetchSeasonRecord", () => {
  const details: YahooLeagueDetails = {
    leagueKey: "449.l.123",
    name: "Alpha",
    season: "2025",
    numTeams: 4,
    startWeek: 1,
    endWeek: 16,
    playoffStartWeek: 4,
    currentWeek: 16,
    isFinished: true,
    renew: null,
  };

  // Routes the two endpoint fetches by URL, the same shape the route injects.
  function stubFetch(teams: unknown, scoreboard: unknown) {
    const urls: string[] = [];
    const fetchJson = async (url: string): Promise<unknown> => {
      urls.push(url);
      return url.includes("/scoreboard") ? scoreboard : teams;
    };
    return { fetchJson, urls };
  }

  it("indexes teams by ascending teamId and counts repeat pairs as doubles", async () => {
    // Teams arrive unsorted; indices must follow teamId order, not arrival.
    const teams = teamsJson([
      teamMeta(3, "Cats", "G3"),
      teamMeta(1, "Aardvarks", "G1"),
      teamMeta(4, "Dogs"),
      teamMeta(2, ""),
    ]);
    const scoreboard = scoreboardJson([
      { week: "1", teamIds: [1, 2] },
      { week: "1", teamIds: [3, 4] },
      { week: "2", teamIds: [1, 3] },
      { week: "2", teamIds: [2, 4] },
      { week: "3", teamIds: [1, 2] }, // repeat of week 1 -> a double
      { week: "3", teamIds: [3, 4] }, // repeat -> a double
      { week: "4", isPlayoffs: "1", teamIds: [1, 4] }, // playoffs: excluded
      { week: "3", teamIds: [9, 1] }, // unknown team id: excluded
    ]);
    const { fetchJson, urls } = stubFetch(teams, scoreboard);

    const record = await fetchSeasonRecord(details, fetchJson);

    expect(record).toEqual({
      seasonYear: "2025",
      seasonName: "Alpha",
      // Empty name falls back to the team id.
      teamNames: ["Aardvarks", "Team 2", "Cats", "Dogs"],
      userIds: ["G1", null, "G3", null],
      doubles: [pairKey(0, 1), pairKey(2, 3)],
      totalMatchups: 6,
      regWeeks: 3,
    });
    // regWeeks = playoffStartWeek - 1 sizes the scoreboard request.
    expect(urls[0]).toBe(`${YAHOO_BASE}/league/449.l.123/teams`);
    expect(urls[1]).toBe(
      `${YAHOO_BASE}/league/449.l.123/scoreboard;week=1,2,3`,
    );
  });

  it("falls back to endWeek for regWeeks when playoffStartWeek is 0", async () => {
    const { fetchJson, urls } = stubFetch(
      teamsJson([teamMeta(1, "A"), teamMeta(2, "B")]),
      scoreboardJson([{ week: "1", teamIds: [1, 2] }]),
    );
    const record = await fetchSeasonRecord(
      { ...details, playoffStartWeek: 0, endWeek: 2 },
      fetchJson,
    );
    expect(record?.regWeeks).toBe(2);
    expect(urls[1]).toContain(";week=1,2");
  });

  it("returns null when teams parse empty - the chain treats it as a dead link", async () => {
    const { fetchJson } = stubFetch({}, scoreboardJson([]));
    expect(await fetchSeasonRecord(details, fetchJson)).toBeNull();
  });

  it("returns null for a zero-regular-week season", async () => {
    const { fetchJson } = stubFetch(
      teamsJson([teamMeta(1, "A"), teamMeta(2, "B")]),
      scoreboardJson([]),
    );
    expect(
      await fetchSeasonRecord({ ...details, playoffStartWeek: 1 }, fetchJson),
    ).toBeNull();
  });

  it("returns null when no regular-season matchups survive filtering", async () => {
    const { fetchJson } = stubFetch(
      teamsJson([teamMeta(1, "A"), teamMeta(2, "B")]),
      scoreboardJson([{ week: "1", isPlayoffs: "1", teamIds: [1, 2] }]),
    );
    expect(await fetchSeasonRecord(details, fetchJson)).toBeNull();
  });
});
