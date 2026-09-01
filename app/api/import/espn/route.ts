// ESPN's lm-api-reads endpoint is undocumented and historically prone to
// breaking changes, so the route is permissive about partial failures: if any
// requested season succeeds the route still returns 200, and total failure
// surfaces the per-season error messages.
//
// Private leagues: ESPN's "Make League Viewable to Public" setting applies
// per season - toggling it opens only the in-progress season, and completed
// seasons keep the visibility they had at the time - so a formerly-private
// league can never import its prior seasons unauthenticated. The route
// accepts the user's espn_s2 cookie in the body (`espnS2`) and forwards it as
// the Cookie header on every season fetch. The cookie is a full ESPN sign-in:
// it must never be logged (the doFetch catch redacts it from Node's header
// errors, and the unhandled-error log only ever sees Error messages), never
// stored, and never cached (`cache: "no-store"`).

import { NextResponse } from "next/server";
import { pairKey } from "@/lib/algorithm";
import type { PairKey } from "@/lib/algorithm";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";
import { buildEspnCookieHeader, normalizeEspnS2 } from "./cookies";
import { EspnSeasonError, settleEspnSeasons } from "./seasons";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";
// Fallback when the client doesn't specify ?seasons=N.
const DEFAULT_SEASONS = 5;
// Hard cap so a misbehaving client can't blow up our per-season API calls.
// Set to 14: the largest recommended lookback across supported formats
// (14-team / 14-week needs 13 prior seasons) plus the newest season that
// anchors format detection. Matches MAX_IMPORT_SEASONS on the client; keep
// them in sync.
const MAX_SEASONS_CAP = 14;

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
  // Only present when the request includes view=mSettings.
  settings?: { name?: string; isPublic?: boolean };
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
  return candidates.some((c) => {
    if (typeof c === "string") return c.includes("AUTH_LEAGUE_NOT_VISIBLE");
    // The live body's `details` entries are objects: `{ message, type:
    // "AUTH_LEAGUE_NOT_VISIBLE", ... }`.
    return (
      c != null &&
      typeof c === "object" &&
      (c as { type?: unknown }).type === "AUTH_LEAGUE_NOT_VISIBLE"
    );
  });
}

// A 401/403 means "private" on the anonymous path. With a cookie it means
// the cookie doesn't open that season: expired, mis-pasted, or the account
// wasn't in the league that year (ESPN's response is identical for all
// three, and for a private league's pre-creation years).
function privateSeasonError(seasonId: number, authed: boolean): Error {
  return new EspnSeasonError(
    authed
      ? `Season ${seasonId} is not visible to this ESPN account.`
      : `Season ${seasonId} is private.`,
    "private",
  );
}

// Fetch wrapper shared by the season fetch and the visibility probe. Never
// caches (a cookie-authed body must not be served to anyone else) and
// redacts the cookie from Node's fetch errors, which echo header values.
async function fetchEspn(
  url: string,
  cookieHeader: string | null,
  seasonId: number,
): Promise<Response> {
  try {
    return await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      cache: "no-store",
    });
  } catch (e) {
    let msg = e instanceof Error ? e.message : "network error";
    if (cookieHeader) {
      // The whole header first, then the bare value in case only that was
      // echoed.
      const value = cookieHeader.slice(cookieHeader.indexOf("=") + 1);
      msg = msg.split(cookieHeader).join("[cookie]");
      msg = msg.split(value).join("[cookie]");
    }
    throw new Error(`Network error fetching season ${seasonId}: ${msg}.`);
  }
}

// Parses the season response body, throwing the classified error for every
// non-success shape. Shared by the season fetch and the visibility probe.
async function readEspnBody(
  res: Response,
  seasonId: number,
  authed: boolean,
): Promise<EspnLeague> {
  if (res.status === 401 || res.status === 403) {
    throw privateSeasonError(seasonId, authed);
  }
  if (res.status === 404) {
    throw new EspnSeasonError(
      `Season ${seasonId} not found for this league.`,
      "not-found",
    );
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
    throw privateSeasonError(seasonId, authed);
  }

  if (!res.ok) {
    throw new Error(`ESPN HTTP ${res.status} for season ${seasonId}.`);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Unexpected ESPN response shape for season ${seasonId}.`);
  }
  return data as EspnLeague;
}

function settingsName(league: EspnLeague): string {
  return league.settings &&
    typeof league.settings === "object" &&
    typeof league.settings.name === "string"
    ? league.settings.name.trim()
    : "";
}

async function fetchEspnSeason(
  leagueId: string,
  seasonId: number,
  cookieHeader: string | null,
) {
  // mSettings is what delivers `settings` (the league name) - the matchup
  // and team views alone return no settings object at all.
  const url = `${BASE}/${seasonId}/segments/0/leagues/${leagueId}?view=mMatchupScore&view=mTeam&view=mSettings`;

  let res = await fetchEspn(url, cookieHeader, seasonId);
  // ESPN's edge occasionally returns transient 502/503s; one retry clears them.
  if (res.status === 502 || res.status === 503) {
    res = await fetchEspn(url, cookieHeader, seasonId);
  }

  const league = await readEspnBody(res, seasonId, cookieHeader !== null);
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

  return {
    seasonYear: String(seasonId),
    seasonName: settingsName(league) || `League ${leagueId}`,
    teamNames,
    userIds,
    doubles,
    totalMatchups: allPairs.length,
    regWeeks,
  };
}

// One unauthenticated settings-only read of a season, for the all-private
// diagnosis: a 200 with `settings.isPublic === true` proves the league
// manager's public toggle took effect for that season. Every other outcome
// (401, 404 in the offseason before the league is renewed, network, odd
// body) resolves to null, and the caller falls back to the plain private
// message - no retry, the base message is the floor.
async function probeSeasonVisibility(
  leagueId: string,
  seasonId: number,
): Promise<{ name: string } | null> {
  const url = `${BASE}/${seasonId}/segments/0/leagues/${leagueId}?view=mSettings`;
  try {
    const res = await fetchEspn(url, null, seasonId);
    const league = await readEspnBody(res, seasonId, false);
    if (league.settings?.isPublic !== true) return null;
    return { name: settingsName(league) };
  } catch {
    return null;
  }
}

// Error-body `code` values the client keys its ESPN cookie prompt on.
// Mirrored as EspnAuthCode in app/components/types.ts.
type EspnAuthCode = "private" | "current-season-only" | "cookies-rejected";

const PRIVATE_LEAGUE_MESSAGE =
  "This ESPN league is private. Import it with your espn_s2 cookie, or use Manual import.";

const COOKIES_REJECTED_MESSAGE =
  "ESPN rejected the cookie for every season. Check that espn_s2 was copied completely, and that the signed-in ESPN account was in this league during those seasons.";

// The probe proved the in-progress season public while every requested
// prior season was denied: the manager already toggled the setting, and it
// can't reach the seasons DoubleCheck imports.
function currentSeasonOnlyMessage(name: string, year: number): string {
  const subject = name ? `"${name}"` : "This ESPN league";
  return `${subject} is public for ${year} only - ESPN keeps its earlier seasons private, and those are the seasons DoubleCheck needs. Import them with your espn_s2 cookie, or use Manual import.`;
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(getClientIp(req));
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

    let body: { leagueId?: string; seasonId?: number; espnS2?: unknown };
    try {
      body = (await req.json()) as typeof body;
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

    const cookie = normalizeEspnS2(body.espnS2);
    if (!cookie.ok) {
      return NextResponse.json({ error: cookie.error }, { status: 400 });
    }
    const cookieHeader =
      cookie.value === null ? null : buildEspnCookieHeader(cookie.value);

    const currentYear = new Date().getFullYear();
    const startSeason =
      body.seasonId && Number.isFinite(body.seasonId)
        ? Math.floor(body.seasonId)
        : currentYear - 1;

    const years = Array.from(
      { length: seasonsCount },
      (_, i) => startSeason - i,
    );
    const { results, failed, errors, allPrivate, allNotFound } =
      await settleEspnSeasons(years, (year) =>
        fetchEspnSeason(leagueId, year, cookieHeader),
      );

    if (results.length === 0) {
      // Every season 404'd: a wrong or nonexistent league ID. Definitive
      // lookup answer, so "not found" wording - and not the private-league
      // message, whose remedies would mislead here.
      if (allNotFound) {
        return NextResponse.json(
          {
            error: `ESPN league "${leagueId}" not found. Check the league ID.`,
          },
          { status: 404 },
        );
      }
      if (allPrivate) {
        // Every season was denied WITH a cookie: the cookie is wrong or the
        // account was never in the league. 401 (the cookie was refused),
        // distinct from the anonymous 403 so the client can tell them apart.
        if (cookieHeader) {
          return NextResponse.json(
            {
              error: COOKIES_REJECTED_MESSAGE,
              code: "cookies-rejected" satisfies EspnAuthCode,
            },
            { status: 401 },
          );
        }
        // Anonymous and every season denied: a private league. Before
        // saying so, one probe of the in-progress season tells a manager
        // who already toggled the league public that the toggle worked but
        // can't reach prior seasons - otherwise they'd toggle it again.
        // Skipped when the requested window already covers the current
        // year (its denial is already known) or lies in the future.
        const probe =
          startSeason < currentYear
            ? await probeSeasonVisibility(leagueId, currentYear)
            : null;
        if (probe) {
          return NextResponse.json(
            {
              error: currentSeasonOnlyMessage(probe.name, currentYear),
              code: "current-season-only" satisfies EspnAuthCode,
            },
            { status: 403 },
          );
        }
        return NextResponse.json(
          {
            error: PRIVATE_LEAGUE_MESSAGE,
            code: "private" satisfies EspnAuthCode,
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

    // Full success keeps the bare-array shape (Array.isArray stays the
    // client's discriminator); partial success tells the client which
    // attempted seasons are missing.
    if (failed.length > 0) {
      return NextResponse.json({ seasons: results, failed });
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
