// Yahoo Fantasy Sports import. Two modes share the route:
//   - POST {} → list the user's NFL leagues across all seasons (for the picker).
//   - POST { leagueKey } → walk the renew chain back from leagueKey, returning
//     ImportedSeasonRecord[] for completed seasons.
//
// Yahoo's API encodes single-resource metadata as an array of single-key
// objects: [{"league_key": "..."}, {"name": "..."}, ...]. flattenYahooMeta
// coalesces that quirk into a flat record so the parsers stay readable.
//
// Tokens come from the encrypted httpOnly cookie set by the OAuth callback. If
// the access token has expired the route refreshes via the refresh token and
// rewrites the cookie before responding so the next call has fresh credentials.
//
// Rate limiting matches /api/import/sleeper and /api/import/espn.
//
// lib/algorithm/ is intentionally not touched: this route lives entirely on the
// platform-integration side and only depends on pairKey from the algorithm
// module's public surface.

import { NextResponse } from "next/server";
import { pairKey } from "@/lib/algorithm";
import type { PairKey } from "@/lib/algorithm";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";
import {
  encryptTokens,
  refreshAccessToken,
  readTokenCookie,
  type YahooTokens,
} from "@/lib/api/yahoo-tokens";

export const runtime = "nodejs";

const TOKEN_COOKIE = "yahoo_tokens";
const TOKEN_MAX_AGE = 60 * 60 * 24 * 30;
const YAHOO_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";
// Fallback when the client doesn't specify ?seasons=N.
const DEFAULT_SEASONS = 5;
// Hard cap so a misbehaving client can't blow up our chain walk. Set to 13
// to cover the largest recommended lookback across supported formats
// (14-team / 14-week needs 13).
const MAX_SEASONS_CAP = 13;
// Seven seasons ending at the current year (e.g. in 2026: 2020–2026). Derived
// at module load so we don't need a yearly hand-edit; the chain traversal
// further down still caps the final return at the request's seasonsCount.
const NFL_SEASONS = Array.from(
  { length: 7 },
  (_, i) => new Date().getFullYear() - 6 + i,
).join(",");

type YahooLeagueMeta = {
  leagueKey: string;
  name: string;
  season: string;
  numTeams: number;
};

type YahooLeagueDetails = YahooLeagueMeta & {
  startWeek: number;
  endWeek: number;
  playoffStartWeek: number;
  currentWeek: number;
  isFinished: boolean;
  renew: string | null;
};

type YahooTeam = {
  teamId: number;
  teamKey: string;
  name: string;
  managerGuid: string | null;
};

type YahooMatchup = {
  week: number;
  isPlayoffs: boolean;
  teamIds: [number, number];
};

type ImportedSeasonRecord = {
  seasonYear: string;
  seasonName: string;
  teamNames: string[];
  userIds: (string | null)[];
  doubles: PairKey[];
  totalMatchups: number;
  regWeeks: number;
};

function flattenYahooMeta(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input) return out;
  if (Array.isArray(input)) {
    for (const item of input) Object.assign(out, flattenYahooMeta(item));
  } else if (typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = v;
    }
  }
  return out;
}

function asNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isTruthyFlag(v: unknown): boolean {
  return v === 1 || v === true || v === "1" || v === "true";
}

function buildLeagueKeyFromRenew(renew: unknown): string | null {
  if (typeof renew !== "string" || !renew || renew === "0") return null;
  if (renew.includes(".l.")) return renew;
  if (renew.includes("_")) {
    const [gameKey, leagueId] = renew.split("_");
    if (gameKey && leagueId) return `${gameKey}.l.${leagueId}`;
  }
  return null;
}

async function fetchYahooJson(
  url: string,
  accessToken: string,
): Promise<unknown> {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}format=json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  return res.json();
}

function parseLeaguesList(json: unknown): YahooLeagueMeta[] {
  const result: YahooLeagueMeta[] = [];
  const root = json as Record<string, unknown> | undefined;
  const users = (root?.fantasy_content as Record<string, unknown> | undefined)
    ?.users as Record<string, unknown> | undefined;
  const userArr = (users?.["0"] as Record<string, unknown> | undefined)?.user;
  if (!Array.isArray(userArr)) return result;
  const games = (userArr[1] as Record<string, unknown> | undefined)?.games as
    | Record<string, unknown>
    | undefined;
  if (!games) return result;
  const gameCount = asNumber(games.count);
  for (let g = 0; g < gameCount; g++) {
    const gameWrapper = games[String(g)] as Record<string, unknown> | undefined;
    const gameArr = gameWrapper?.game;
    if (!Array.isArray(gameArr)) continue;
    const leagues = (gameArr[1] as Record<string, unknown> | undefined)
      ?.leagues as Record<string, unknown> | undefined;
    if (!leagues) continue;
    const leagueCount = asNumber(leagues.count);
    for (let l = 0; l < leagueCount; l++) {
      const leagueWrapper = leagues[String(l)] as
        | Record<string, unknown>
        | undefined;
      const leagueArr = leagueWrapper?.league;
      if (!leagueArr) continue;
      const meta = flattenYahooMeta(leagueArr);
      const leagueKey = String(meta.league_key || "");
      if (!leagueKey) continue;
      result.push({
        leagueKey,
        name: String(meta.name || leagueKey),
        season: String(meta.season || ""),
        numTeams: asNumber(meta.num_teams),
      });
    }
  }
  const byName = new Map<string, YahooLeagueMeta>();
  for (const league of result) {
    const existing = byName.get(league.name);
    if (!existing || Number(league.season) > Number(existing.season)) {
      byName.set(league.name, league);
    }
  }
  return Array.from(byName.values());
}

function parseLeagueDetails(json: unknown): YahooLeagueDetails | null {
  const root = json as Record<string, unknown> | undefined;
  const leagueArr = (
    root?.fantasy_content as Record<string, unknown> | undefined
  )?.league;
  if (!Array.isArray(leagueArr)) return null;
  const meta = flattenYahooMeta(leagueArr[0]);
  const leagueKey = String(meta.league_key || "");
  if (!leagueKey) return null;

  let playoffStartWeek = asNumber(meta.playoff_start_week);
  const sub = leagueArr[1] as Record<string, unknown> | undefined;
  if (sub?.settings) {
    const settingsRaw = sub.settings;
    const settings = Array.isArray(settingsRaw)
      ? flattenYahooMeta(settingsRaw)
      : (settingsRaw as Record<string, unknown>);
    const psw = asNumber(settings.playoff_start_week);
    if (psw > 0) playoffStartWeek = psw;
  }

  return {
    leagueKey,
    name: String(meta.name || leagueKey),
    season: String(meta.season || ""),
    numTeams: asNumber(meta.num_teams),
    startWeek: asNumber(meta.start_week, 1),
    endWeek: asNumber(meta.end_week),
    playoffStartWeek,
    currentWeek: asNumber(meta.current_week),
    isFinished: isTruthyFlag(meta.is_finished),
    renew: buildLeagueKeyFromRenew(meta.renew),
  };
}

function parseTeams(json: unknown): YahooTeam[] {
  const result: YahooTeam[] = [];
  const root = json as Record<string, unknown> | undefined;
  const leagueArr = (
    root?.fantasy_content as Record<string, unknown> | undefined
  )?.league;
  if (!Array.isArray(leagueArr)) return result;
  const teamsObj = (leagueArr[1] as Record<string, unknown> | undefined)
    ?.teams as Record<string, unknown> | undefined;
  if (!teamsObj) return result;
  const count = asNumber(teamsObj.count);
  for (let i = 0; i < count; i++) {
    const wrapper = teamsObj[String(i)] as Record<string, unknown> | undefined;
    const teamArr = wrapper?.team;
    if (!teamArr) continue;
    const meta = flattenYahooMeta(
      Array.isArray(teamArr) ? teamArr[0] : teamArr,
    );
    const teamKey = String(meta.team_key || "");
    const teamId = asNumber(meta.team_id, NaN);
    const name = String(meta.name || "");
    let managerGuid: string | null = null;
    const managers = meta.managers;
    if (Array.isArray(managers) && managers.length > 0) {
      const first = managers[0] as Record<string, unknown> | undefined;
      const mgr = first?.manager as Record<string, unknown> | undefined;
      if (mgr?.guid && typeof mgr.guid === "string") managerGuid = mgr.guid;
    }
    if (teamKey && Number.isFinite(teamId)) {
      result.push({ teamKey, teamId, name, managerGuid });
    }
  }
  return result;
}

function parseScoreboard(json: unknown): YahooMatchup[] {
  const result: YahooMatchup[] = [];
  const root = json as Record<string, unknown> | undefined;
  const leagueArr = (
    root?.fantasy_content as Record<string, unknown> | undefined
  )?.league;
  if (!Array.isArray(leagueArr)) return result;
  const sb = (leagueArr[1] as Record<string, unknown> | undefined)
    ?.scoreboard as Record<string, unknown> | undefined;
  if (!sb) return result;
  const matchupsObj = (sb["0"] as Record<string, unknown> | undefined)
    ?.matchups as Record<string, unknown> | undefined;
  if (!matchupsObj) return result;
  const count = asNumber(matchupsObj.count);
  for (let i = 0; i < count; i++) {
    const wrapper = matchupsObj[String(i)] as
      | Record<string, unknown>
      | undefined;
    const matchup = wrapper?.matchup as Record<string, unknown> | undefined;
    if (!matchup) continue;
    const meta = flattenYahooMeta(matchup);
    const week = asNumber(meta.week, NaN);
    const isPlayoffs = isTruthyFlag(meta.is_playoffs);
    const teamsHolder = (matchup["0"] as Record<string, unknown> | undefined)
      ?.teams as Record<string, unknown> | undefined;
    if (!teamsHolder) continue;
    const teamCount = asNumber(teamsHolder.count);
    const teamIds: number[] = [];
    for (let t = 0; t < teamCount; t++) {
      const tWrapper = teamsHolder[String(t)] as
        | Record<string, unknown>
        | undefined;
      const teamArr = tWrapper?.team;
      if (!teamArr) continue;
      const tMeta = flattenYahooMeta(
        Array.isArray(teamArr) ? teamArr[0] : teamArr,
      );
      const tId = asNumber(tMeta.team_id, NaN);
      if (Number.isFinite(tId)) teamIds.push(tId);
    }
    if (Number.isFinite(week) && teamIds.length === 2) {
      result.push({ week, isPlayoffs, teamIds: [teamIds[0]!, teamIds[1]!] });
    }
  }
  return result;
}

async function getValidTokens(
  req: Request,
): Promise<{ tokens: YahooTokens; refreshed: boolean }> {
  const tokens = readTokenCookie(req, TOKEN_COOKIE);
  if (!tokens) throw new Error("NOT_AUTHENTICATED");
  if (Date.now() >= tokens.expiresAt - 60_000) {
    const refreshed = await refreshAccessToken(tokens.refreshToken);
    return { tokens: refreshed, refreshed: true };
  }
  return { tokens, refreshed: false };
}

function setRefreshedCookie(res: NextResponse, tokens: YahooTokens) {
  res.cookies.set(TOKEN_COOKIE, encryptTokens(tokens), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TOKEN_MAX_AGE,
  });
}

async function fetchSeasonRecord(
  details: YahooLeagueDetails,
  accessToken: string,
): Promise<ImportedSeasonRecord | null> {
  const teamsJson = await fetchYahooJson(
    `${YAHOO_BASE}/league/${details.leagueKey}/teams`,
    accessToken,
  );
  const teams = parseTeams(teamsJson);
  if (teams.length === 0) return null;

  const sorted = [...teams].sort((a, b) => a.teamId - b.teamId);
  const teamIdToIdx: Record<number, number> = {};
  const teamNames: string[] = [];
  const userIds: (string | null)[] = [];
  sorted.forEach((t, idx) => {
    teamIdToIdx[t.teamId] = idx;
    teamNames.push(t.name || `Team ${t.teamId}`);
    userIds.push(t.managerGuid);
  });

  const regWeeks =
    details.playoffStartWeek > 0
      ? details.playoffStartWeek - 1
      : details.endWeek;
  if (regWeeks <= 0) return null;

  const weekParam = Array.from({ length: regWeeks }, (_, i) => i + 1).join(",");
  const sbJson = await fetchYahooJson(
    `${YAHOO_BASE}/league/${details.leagueKey}/scoreboard;week=${weekParam}`,
    accessToken,
  );
  const matchups = parseScoreboard(sbJson);

  const allPairs: [number, number][] = [];
  for (const m of matchups) {
    if (m.isPlayoffs) continue;
    const a = teamIdToIdx[m.teamIds[0]];
    const b = teamIdToIdx[m.teamIds[1]];
    if (a === undefined || b === undefined) continue;
    allPairs.push([a, b]);
  }

  if (allPairs.length === 0) return null;

  const counts: Record<PairKey, number> = {};
  allPairs.forEach(([a, b]) => {
    const k = pairKey(a, b);
    counts[k] = (counts[k] || 0) + 1;
  });
  const doubles = Object.entries(counts)
    .filter(([, v]) => v > 1)
    .map(([k]) => k);

  return {
    seasonYear: details.season,
    seasonName: details.name,
    teamNames,
    userIds,
    doubles,
    totalMatchups: allPairs.length,
    regWeeks,
  };
}

async function fetchSeasonChain(
  startKey: string,
  accessToken: string,
  seasonsCount: number,
): Promise<ImportedSeasonRecord[]> {
  const records: ImportedSeasonRecord[] = [];
  let currentKey: string | null = startKey;
  const seen = new Set<string>();

  for (
    let depth = 0;
    depth < seasonsCount && currentKey && records.length < seasonsCount;
    depth++
  ) {
    if (seen.has(currentKey)) break;
    seen.add(currentKey);

    const detailsJson = await fetchYahooJson(
      `${YAHOO_BASE}/league/${currentKey};out=settings`,
      accessToken,
    );
    const details = parseLeagueDetails(detailsJson);
    if (!details) break;

    if (details.isFinished) {
      const record = await fetchSeasonRecord(details, accessToken);
      if (record) records.push(record);
    }

    currentKey = details.renew;
  }

  return records;
}

async function readBody(req: Request): Promise<{ leagueKey?: string }> {
  try {
    const raw = await req.text();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { leagueKey?: unknown };
    if (typeof parsed?.leagueKey === "string") {
      return { leagueKey: parsed.leagueKey };
    }
    return {};
  } catch {
    return {};
  }
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

    const body = await readBody(req);
    const leagueKey = body.leagueKey?.trim();

    let tokens: YahooTokens;
    let refreshed = false;
    try {
      const got = await getValidTokens(req);
      tokens = got.tokens;
      refreshed = got.refreshed;
    } catch (e) {
      if ((e as Error).message === "NOT_AUTHENTICATED") {
        return NextResponse.json(
          { error: "Not connected to Yahoo. Connect first." },
          { status: 401 },
        );
      }
      console.error("[/api/import/yahoo] Token error:", e);
      return NextResponse.json(
        { error: `Yahoo token error: ${(e as Error).message}` },
        { status: 502 },
      );
    }

    try {
      if (!leagueKey) {
        const json = await fetchYahooJson(
          `${YAHOO_BASE}/users;use_login=1/games;game_codes=nfl;seasons=${NFL_SEASONS}/leagues`,
          tokens.accessToken,
        );
        const leagues = parseLeaguesList(json);
        const res = NextResponse.json({ leagues });
        if (refreshed) setRefreshedCookie(res, tokens);
        return res;
      }

      if (!/^[\w.]+\.l\.\d+$/.test(leagueKey)) {
        return NextResponse.json(
          { error: "leagueKey must look like '<gameKey>.l.<leagueId>'." },
          { status: 400 },
        );
      }

      const records = await fetchSeasonChain(
        leagueKey,
        tokens.accessToken,
        seasonsCount,
      );
      if (records.length === 0) {
        return NextResponse.json(
          {
            error: "No completed seasons found in this Yahoo league's history.",
          },
          { status: 404 },
        );
      }
      const res = NextResponse.json(records);
      if (refreshed) setRefreshedCookie(res, tokens);
      return res;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "UNAUTHORIZED") {
        return NextResponse.json(
          { error: "Yahoo authorization expired. Please reconnect." },
          { status: 401 },
        );
      }
      console.error("[/api/import/yahoo] Fetch error:", e);
      return NextResponse.json(
        { error: `Failed to fetch from Yahoo: ${msg}` },
        { status: 502 },
      );
    }
  } catch (e) {
    console.error("[/api/import/yahoo] Unhandled error:", e);
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? `Failed to fetch from Yahoo: ${e.message}`
            : "Unexpected error processing Yahoo import.",
      },
      { status: 502 },
    );
  }
}
