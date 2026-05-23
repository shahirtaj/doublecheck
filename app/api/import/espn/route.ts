// ESPN's lm-api-reads endpoint is undocumented and historically prone to
// breaking changes, so the route is permissive about partial failures: if any
// requested season succeeds the route still returns 200, and total failure
// surfaces the per-season error messages.
// Public leagues only — private leagues require espn_s2 + SWID cookies, which
// are out of scope for this phase.

import { NextResponse } from "next/server";
import { pairKey } from "@/lib/algorithm";
import type { PairKey } from "@/lib/algorithm";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";
// Fallback when the client doesn't specify ?seasons=N.
const DEFAULT_SEASONS = 5;
// Hard cap so a misbehaving client can't blow up our per-season API calls.
// Set to 13 to cover the largest recommended lookback across supported
// formats (14-team / 14-week needs 13).
const MAX_SEASONS_CAP = 13;

type EspnTeam = {
  id: number;
  name?: string;
  location?: string;
  nickname?: string;
  primaryOwner?: string | null;
  owners?: string[];
};

type EspnMatchup = {
  matchupPeriodId?: number;
  playoffTierType?: string | null;
  home?: { teamId?: number };
  away?: { teamId?: number };
};

type EspnLeague = {
  teams?: EspnTeam[];
  schedule?: EspnMatchup[];
  settings?: { name?: string };
};

// ESPN signals "this league is private" inconsistently: sometimes 401, often
// 403, and occasionally a 200 with an AUTH_LEAGUE_NOT_VISIBLE message in the
// body.
function hasAuthLeagueNotVisible(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  // ESPN wraps auth errors in a top-level `messages` array or a `details`
  // array, sometimes inside a 200 body. Check known paths rather than
  // stringifying the whole response (which could false-positive on a team
  // name containing the error string).
  const candidates: unknown[] = [];
  if (Array.isArray(obj.messages)) candidates.push(...obj.messages);
  if (Array.isArray(obj.details)) candidates.push(...obj.details);
  if (typeof obj.message === "string") candidates.push(obj.message);
  if (candidates.length === 0) return false;
  return candidates.some(
    (c) => typeof c === "string" && c.includes("AUTH_LEAGUE_NOT_VISIBLE"),
  );
}

function privateLeagueError(seasonId: number): Error {
  return new Error(
    `Season ${seasonId} is private. Public leagues only for now.`,
  );
}

async function fetchEspnSeason(leagueId: string, seasonId: number) {
  const url = `${BASE}/${seasonId}/segments/0/leagues/${leagueId}?view=mMatchupScore&view=mTeam`;

  async function doFetch(): Promise<Response> {
    try {
      return await fetch(url, { headers: { Accept: "application/json" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "network error";
      throw new Error(`Network error fetching season ${seasonId}: ${msg}.`);
    }
  }

  let res = await doFetch();
  // ESPN's edge occasionally returns transient 502/503s; one retry clears them.
  if (res.status === 502 || res.status === 503) {
    res = await doFetch();
  }

  if (res.status === 401 || res.status === 403) {
    throw privateLeagueError(seasonId);
  }
  if (res.status === 404) {
    throw new Error(`Season ${seasonId} not found for this league.`);
  }

  // Read as text first so we can give a useful message if ESPN returns an
  // HTML error page from CloudFront (or any other non-JSON body) instead of
  // crashing on res.json().
  let raw: string;
  try {
    raw = await res.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "stream error";
    throw new Error(
      `Could not read ESPN response body for season ${seasonId}: ${msg}.`,
    );
  }

  let data: unknown;
  if (raw.length === 0) {
    if (!res.ok) {
      throw new Error(
        `ESPN HTTP ${res.status} for season ${seasonId} (empty response).`,
      );
    }
    throw new Error(`Empty response from ESPN for season ${seasonId}.`);
  }
  try {
    data = JSON.parse(raw);
  } catch {
    const snippet = raw.slice(0, 80).replace(/\s+/g, " ").trim();
    throw new Error(
      `ESPN returned non-JSON for season ${seasonId} (status ${res.status})${snippet ? `: "${snippet}"` : ""}.`,
    );
  }

  // Auth check has to run before the !res.ok branch because ESPN occasionally
  // returns AUTH_LEAGUE_NOT_VISIBLE inside a 200 body.
  if (hasAuthLeagueNotVisible(data)) {
    throw privateLeagueError(seasonId);
  }

  if (!res.ok) {
    throw new Error(`ESPN HTTP ${res.status} for season ${seasonId}.`);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Unexpected ESPN response shape for season ${seasonId}.`);
  }
  const league = data as EspnLeague;
  if (!Array.isArray(league.teams) || !Array.isArray(league.schedule)) {
    throw new Error(`Unexpected ESPN response shape for season ${seasonId}.`);
  }

  const validTeams = league.teams.filter(
    (t): t is EspnTeam =>
      t != null &&
      typeof t === "object" &&
      typeof (t as EspnTeam).id === "number" &&
      Number.isFinite((t as EspnTeam).id),
  );
  if (validTeams.length === 0) {
    throw new Error(`No teams with valid IDs returned for season ${seasonId}.`);
  }

  const teams = [...validTeams].sort((a, b) => a.id - b.id);
  const teamIdToIdx: Record<number, number> = {};
  const teamNames: string[] = [];
  const userIds: (string | null)[] = [];

  teams.forEach((t, idx) => {
    teamIdToIdx[t.id] = idx;
    const composed = `${t.location || ""} ${t.nickname || ""}`.trim();
    const name =
      (t.name && String(t.name).trim()) || composed || `Team ${t.id}`;
    teamNames.push(name);
    const owner =
      (typeof t.primaryOwner === "string" && t.primaryOwner) ||
      (Array.isArray(t.owners) &&
        typeof t.owners[0] === "string" &&
        t.owners[0]) ||
      null;
    userIds.push(owner);
  });

  const regSchedule = league.schedule.filter(
    (m): m is EspnMatchup =>
      m != null &&
      typeof m === "object" &&
      (m.playoffTierType === "NONE" || m.playoffTierType == null) &&
      m.home != null &&
      m.away != null &&
      typeof m.home.teamId === "number" &&
      typeof m.away.teamId === "number",
  );

  let regWeeks = 0;
  for (const m of regSchedule) {
    if (typeof m.matchupPeriodId === "number" && m.matchupPeriodId > regWeeks) {
      regWeeks = m.matchupPeriodId;
    }
  }

  const allPairs: [number, number][] = [];
  for (const m of regSchedule) {
    const a = teamIdToIdx[m.home!.teamId!];
    const b = teamIdToIdx[m.away!.teamId!];
    if (a === undefined || b === undefined) continue;
    allPairs.push([a, b]);
  }

  if (allPairs.length === 0) {
    throw new Error(`No regular season matchups found for season ${seasonId}.`);
  }

  const counts: Record<PairKey, number> = {};
  allPairs.forEach(([a, b]) => {
    const k = pairKey(a, b);
    counts[k] = (counts[k] || 0) + 1;
  });
  const doubles = Object.entries(counts)
    .filter(([, v]) => v > 1)
    .map(([k]) => k);

  const settingsName =
    league.settings &&
    typeof league.settings === "object" &&
    typeof league.settings.name === "string"
      ? league.settings.name.trim()
      : "";

  return {
    seasonYear: String(seasonId),
    seasonName: settingsName || `League ${leagueId}`,
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

    let body: { leagueId?: string; seasonId?: number };
    try {
      body = (await req.json()) as { leagueId?: string; seasonId?: number };
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 },
      );
    }

    const leagueId = (body.leagueId || "").trim();
    if (!leagueId || !/^\d+$/.test(leagueId) || /^0+$/.test(leagueId)) {
      return NextResponse.json(
        {
          error:
            "leagueId is required and must be a positive numeric ESPN league ID.",
        },
        { status: 400 },
      );
    }

    const startSeason =
      body.seasonId && Number.isFinite(body.seasonId)
        ? Math.floor(body.seasonId)
        : new Date().getFullYear() - 1;

    const years = Array.from(
      { length: seasonsCount },
      (_, i) => startSeason - i,
    );
    const settled = await Promise.allSettled(
      years.map((year) => fetchEspnSeason(leagueId, year)),
    );

    const results: Awaited<ReturnType<typeof fetchEspnSeason>>[] = [];
    const errors: string[] = [];
    let allPrivate = true;

    settled.forEach((result, i) => {
      const year = years[i]!;
      if (result.status === "fulfilled") {
        results.push(result.value);
        allPrivate = false;
      } else {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : typeof result.reason === "string"
              ? result.reason
              : "unknown error";
        if (!msg.includes("is private.") && !msg.includes("not found"))
          allPrivate = false;
        errors.push(`${year}: ${msg}`);
      }
    });

    if (results.length === 0) {
      // If every season failed because the league is private, surface that as
      // a 403 with a clean message instead of burying it in a 502 dump.
      if (allPrivate) {
        return NextResponse.json(
          {
            error:
              "This ESPN league is private. Temporarily make your league public (see instructions), then try again. Or, choose Manual entry to import without changing any ESPN settings.",
            helpUrl:
              "https://support.espn.com/hc/en-us/articles/47160849553940-Making-a-Private-League-Public-LM-Only",
          },
          { status: 403 },
        );
      }
      return NextResponse.json(
        {
          error: `Could not fetch any seasons from ESPN. ${errors.join(" | ")}.`,
        },
        { status: 502 },
      );
    }

    return NextResponse.json(results);
  } catch (e) {
    console.error("[/api/import/espn] Unhandled error:", e);
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? `Failed to fetch from ESPN: ${e.message}`
            : "Unexpected error processing ESPN import.",
      },
      { status: 502 },
    );
  }
}
