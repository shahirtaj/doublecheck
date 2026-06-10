// Direct port of fetch-sleeper.js into a serverless Route Handler. Server-side
// fetch eliminates the browser CORS issue that the original Node script worked
// around. Two modes share the route:
//   - POST { leagueId } → walk the renew chain back from leagueId, returning
//     ImportedSeasonRecord[] for completed seasons (the original behavior).
//   - POST { username } → look up the Sleeper user_id, list their current-year
//     NFL leagues, and return them as { leagues } for the client picker.

import { NextResponse } from "next/server";
import { pairKey } from "@/lib/algorithm";
import type { PairKey } from "@/lib/algorithm";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";

const BASE = "https://api.sleeper.app/v1";
// Fallback when the client doesn't specify ?seasons=N. Matches the previous
// hardcoded cap so existing callers see no change.
const DEFAULT_SEASONS = 5;
// Hard cap on how many seasons one request can pull, regardless of input.
// Bounds chain depth + per-season API calls + response size. Set to 13 to
// cover the largest recommended lookback across supported formats
// (14-team / 14-week needs 13).
const MAX_SEASONS_CAP = 13;
const MAX_USERNAME_LENGTH = 50;

type SleeperLeague = {
  league_id?: string;
  name?: string;
  season?: string;
  previous_league_id?: string | null;
  settings?: { playoff_week_start?: number };
};

type SleeperLeagueOption = {
  leagueId: string;
  name: string;
  season: string;
};

type SleeperUser = {
  user_id: string;
  display_name?: string;
  metadata?: { team_name?: string };
};

type SleeperRoster = {
  roster_id: number;
  owner_id?: string | null;
};

type SleeperMatchup = {
  matchup_id?: number | null;
  roster_id: number;
  points?: number;
};

type DiscoveredSeason = {
  leagueId: string;
  name: string;
  season: string;
  hasData: boolean;
  settings?: { playoff_week_start?: number };
};

// Sleeper uses the literal string "0" to mean "no previous league" on the
// first season of a chain. "0" is truthy in JS, so a naive `id || null` walks
// into a 404 on the next iteration and the whole chain explodes.
function nextChainId(prev: unknown): string | null {
  if (typeof prev !== "string") return null;
  const trimmed = prev.trim();
  if (!trimmed || trimmed === "0") return null;
  return trimmed;
}

class LeagueNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeagueNotFoundError";
  }
}

class UserNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserNotFoundError";
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as T;
}

async function lookupUserLeagues(
  username: string,
): Promise<SleeperLeagueOption[]> {
  let user: { user_id?: string } | null;
  try {
    user = await fetchJson<{ user_id?: string } | null>(
      `${BASE}/user/${encodeURIComponent(username)}`,
    );
  } catch {
    throw new UserNotFoundError(
      `Sleeper user "${username}" not found. Check the spelling.`,
    );
  }
  if (!user || typeof user.user_id !== "string" || !user.user_id) {
    throw new UserNotFoundError(
      `Sleeper user "${username}" not found. Check the spelling.`,
    );
  }
  // Try the current year first, then fall back to the prior year. Most
  // returning leagues only show up under the new year once the commissioner
  // recreates them (often weeks before the draft); during the offseason the
  // user's "active" leagues are still under last year. The chain walker on
  // the leagueId side handles historical seasons regardless.
  const currentYear = new Date().getFullYear();
  for (const year of [currentYear, currentYear - 1]) {
    const options = await fetchUserLeaguesForYear(user.user_id, year);
    if (options.length > 0) return options;
  }
  return [];
}

async function fetchUserLeaguesForYear(
  userId: string,
  year: number,
): Promise<SleeperLeagueOption[]> {
  let leagues: SleeperLeague[];
  try {
    leagues = await fetchJson<SleeperLeague[]>(
      `${BASE}/user/${userId}/leagues/nfl/${year}`,
    );
  } catch {
    return [];
  }
  if (!Array.isArray(leagues)) return [];
  return leagues
    .filter(
      (l): l is SleeperLeague & { league_id: string } =>
        typeof l?.league_id === "string" && l.league_id.length > 0,
    )
    .map((l) => ({
      leagueId: l.league_id,
      name: (l.name || "").trim() || l.league_id,
      season: (l.season || "").trim() || String(year),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function discoverChain(
  leagueId: string,
  chainDepth: number,
): Promise<DiscoveredSeason[]> {
  const seasons: DiscoveredSeason[] = [];
  let currentId: string | null = leagueId;

  for (let depth = 0; depth < chainDepth && currentId; depth++) {
    let league: SleeperLeague | null = null;
    try {
      league = await fetchJson<SleeperLeague>(`${BASE}/league/${currentId}`);
    } catch (e) {
      if (depth === 0) {
        throw new LeagueNotFoundError(
          `Sleeper league ${currentId} could not be loaded. Verify the league ID.`,
        );
      }
      // Mid-chain failures (e.g. an old league that's been deleted) just stop
      // the walk; we still return the seasons we did find.
      break;
    }

    if (!league || typeof league !== "object" || !league.league_id) {
      if (depth === 0) {
        throw new LeagueNotFoundError(
          `Sleeper returned no league for ID ${currentId}. Verify the league ID.`,
        );
      }
      break;
    }

    let week1: SleeperMatchup[] | null = null;
    try {
      week1 = await fetchJson<SleeperMatchup[]>(
        `${BASE}/league/${currentId}/matchups/1`,
      );
    } catch {
      week1 = null;
    }
    const hasData =
      Array.isArray(week1) &&
      week1.some((m) => m.matchup_id != null && (m.points ?? 0) > 0);

    seasons.push({
      leagueId: league.league_id,
      name: league.name || currentId,
      season: league.season || "",
      hasData,
      settings: league.settings,
    });

    currentId = nextChainId(league.previous_league_id);
  }
  return seasons;
}

async function fetchSeason(
  leagueId: string,
  settings: DiscoveredSeason["settings"],
) {
  const users = await fetchJson<SleeperUser[]>(
    `${BASE}/league/${leagueId}/users`,
  );
  const rosters = await fetchJson<SleeperRoster[]>(
    `${BASE}/league/${leagueId}/rosters`,
  );

  const usersArr = Array.isArray(users) ? users : [];
  const rostersArr = Array.isArray(rosters) ? rosters : [];
  if (rostersArr.length === 0) {
    throw new Error(`Sleeper returned no rosters for league ${leagueId}.`);
  }

  const ownerInfo: Record<string, string> = {};
  usersArr.forEach((u) => {
    if (!u || typeof u.user_id !== "string") return;
    ownerInfo[u.user_id] = u.display_name || u.metadata?.team_name || u.user_id;
  });

  const sorted = [...rostersArr].sort((a, b) => a.roster_id - b.roster_id);
  const rosterIdToIdx: Record<number, number> = {};
  const teamNames: string[] = [];
  const userIds: (string | null)[] = [];
  sorted.forEach((r, idx) => {
    rosterIdToIdx[r.roster_id] = idx;
    teamNames.push(
      (r.owner_id && ownerInfo[r.owner_id]) || `Roster ${r.roster_id}`,
    );
    userIds.push(r.owner_id || null);
  });

  const regWeeks = settings?.playoff_week_start
    ? settings.playoff_week_start - 1
    : 14;

  const weekResults = await Promise.all(
    Array.from({ length: regWeeks }, (_, i) =>
      fetchJson<SleeperMatchup[]>(
        `${BASE}/league/${leagueId}/matchups/${i + 1}`,
      ),
    ),
  );

  const allPairs: [number, number][] = [];
  for (const matchups of weekResults) {
    if (!Array.isArray(matchups)) continue;
    const groups: Record<number, number[]> = {};
    matchups.forEach((m) => {
      if (m.matchup_id == null) return;
      if (!groups[m.matchup_id]) groups[m.matchup_id] = [];
      groups[m.matchup_id]!.push(m.roster_id);
    });
    Object.values(groups).forEach((pair) => {
      if (pair.length === 2) {
        const a = rosterIdToIdx[pair[0]!];
        const b = rosterIdToIdx[pair[1]!];
        if (a !== undefined && b !== undefined) allPairs.push([a, b]);
      }
    });
  }

  const counts: Record<PairKey, number> = {};
  allPairs.forEach(([a, b]) => {
    const k = pairKey(a, b);
    counts[k] = (counts[k] || 0) + 1;
  });
  const doubles = Object.entries(counts)
    .filter(([, v]) => v > 1)
    .map(([k]) => k);

  return {
    teamNames,
    userIds,
    doubles,
    totalMatchups: allPairs.length,
    regWeeks,
  };
}

export async function POST(req: Request) {
  try {
    const rl = checkRateLimit(getClientIp(req));
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Rate limit exceeded. Retry in ${rl.retryAfter}s.` },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
      );
    }

    // Optional ?seasons=N lets the client right-size the fetch to the
    // format's recommended lookback. Falls back to DEFAULT_SEASONS when
    // missing/invalid and is clamped to MAX_SEASONS_CAP.
    const requestedSeasons = parseInt(
      new URL(req.url).searchParams.get("seasons") || "",
      10,
    );
    const seasonsCount =
      Number.isFinite(requestedSeasons) && requestedSeasons > 0
        ? Math.min(requestedSeasons, MAX_SEASONS_CAP)
        : DEFAULT_SEASONS;

    let body: { leagueId?: string; username?: string };
    try {
      body = (await req.json()) as { leagueId?: string; username?: string };
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 },
      );
    }

    const username = (body.username || "").trim();
    if (username) {
      if (username.length > MAX_USERNAME_LENGTH) {
        return NextResponse.json(
          {
            error: `Username too long (max ${MAX_USERNAME_LENGTH} characters).`,
          },
          { status: 400 },
        );
      }
      if (/^\d+$/.test(username)) {
        return NextResponse.json(
          {
            error:
              "Username must contain at least one non-numeric character. Send a leagueId for numeric IDs.",
          },
          { status: 400 },
        );
      }
      try {
        const leagues = await lookupUserLeagues(username);
        if (leagues.length === 0) {
          const currentYear = new Date().getFullYear();
          return NextResponse.json(
            {
              error: `No Sleeper NFL leagues found for "${username}" in ${currentYear - 1} or ${currentYear}. If your league is older, enter its league ID instead.`,
            },
            { status: 404 },
          );
        }
        return NextResponse.json({ leagues });
      } catch (e) {
        if (e instanceof UserNotFoundError) {
          return NextResponse.json({ error: e.message }, { status: 404 });
        }
        console.error("[/api/import/sleeper] lookupUserLeagues failed:", e);
        return NextResponse.json(
          { error: `Failed to look up Sleeper user: ${(e as Error).message}` },
          { status: 502 },
        );
      }
    }

    const leagueId = (body.leagueId || "").trim();
    if (!leagueId || !/^\d+$/.test(leagueId) || /^0+$/.test(leagueId)) {
      return NextResponse.json(
        {
          error:
            "Provide a Sleeper username or a positive numeric Sleeper league ID.",
        },
        { status: 400 },
      );
    }

    let chain: DiscoveredSeason[];
    try {
      chain = await discoverChain(leagueId, seasonsCount);
    } catch (e) {
      if (e instanceof LeagueNotFoundError) {
        return NextResponse.json({ error: e.message }, { status: 404 });
      }
      console.error("[/api/import/sleeper] discoverChain failed:", e);
      return NextResponse.json(
        {
          error: `Failed to fetch league chain from Sleeper: ${(e as Error).message}`,
        },
        { status: 502 },
      );
    }

    const completed = chain.filter((s) => s.hasData);
    if (completed.length === 0) {
      return NextResponse.json(
        { error: "No completed seasons found in this league's history." },
        { status: 404 },
      );
    }

    // Fetch seasons concurrently and tolerate per-season failures: one dead
    // season (e.g. a deleted league mid-chain) shouldn't 502 the seasons that
    // did load. allSettled preserves input order, so the response stays
    // most-recent-first regardless of which fetch finishes when.
    const toFetch = completed.slice(0, seasonsCount);
    const settled = await Promise.allSettled(
      toFetch.map((target) => fetchSeason(target.leagueId, target.settings)),
    );

    const results: {
      seasonYear: string;
      seasonName: string;
      teamNames: string[];
      userIds: (string | null)[];
      doubles: string[];
      totalMatchups: number;
      regWeeks: number;
    }[] = [];
    const errors: string[] = [];

    settled.forEach((result, i) => {
      const target = toFetch[i]!;
      if (result.status === "fulfilled") {
        const data = result.value;
        results.push({
          seasonYear: target.season,
          seasonName: target.name,
          teamNames: data.teamNames,
          userIds: data.userIds,
          doubles: data.doubles,
          totalMatchups: data.totalMatchups,
          regWeeks: data.regWeeks,
        });
      } else {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : typeof result.reason === "string"
              ? result.reason
              : "unknown error";
        errors.push(`${target.season || target.leagueId}: ${msg}`);
      }
    });

    if (results.length === 0) {
      return NextResponse.json(
        {
          error: `Could not fetch any seasons from Sleeper. ${errors.join(" | ")}.`,
        },
        { status: 502 },
      );
    }

    return NextResponse.json(results);
  } catch (e) {
    console.error("[/api/import/sleeper] Unhandled error:", e);
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? `Failed to fetch from Sleeper: ${e.message}`
            : "Unexpected error processing Sleeper import.",
      },
      { status: 502 },
    );
  }
}
