// Direct port of fetch-sleeper.js into a serverless Route Handler. Server-side
// fetch eliminates the browser CORS issue that the original Node script worked
// around. POST with { leagueId, seasons? }, returns an array of season records
// shaped to match the season-record format the generate page consumes.

import { NextResponse } from "next/server";
import { pairKey } from "@/lib/algorithm";
import type { PairKey } from "@/lib/algorithm";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";

const BASE = "https://api.sleeper.app/v1";
const MAX_SEASONS = 5;
const MAX_CHAIN_DEPTH = 5;

type SleeperLeague = {
  league_id?: string;
  name?: string;
  season?: string;
  previous_league_id?: string | null;
  settings?: { playoff_week_start?: number };
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

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as T;
}

async function discoverChain(leagueId: string): Promise<DiscoveredSeason[]> {
  const seasons: DiscoveredSeason[] = [];
  let currentId: string | null = leagueId;

  for (let depth = 0; depth < MAX_CHAIN_DEPTH && currentId; depth++) {
    const league: SleeperLeague = await fetchJson(`${BASE}/league/${currentId}`);
    if (!league?.league_id) break;

    const week1 = await fetchJson<SleeperMatchup[]>(`${BASE}/league/${currentId}/matchups/1`);
    const hasData =
      Array.isArray(week1) && week1.some((m) => m.matchup_id != null && (m.points ?? 0) > 0);

    seasons.push({
      leagueId: league.league_id,
      name: league.name || currentId,
      season: league.season || "",
      hasData,
      settings: league.settings,
    });

    currentId = league.previous_league_id || null;
  }
  return seasons;
}

async function fetchSeason(leagueId: string, settings: DiscoveredSeason["settings"]) {
  const users = await fetchJson<SleeperUser[]>(`${BASE}/league/${leagueId}/users`);
  const rosters = await fetchJson<SleeperRoster[]>(`${BASE}/league/${leagueId}/rosters`);

  const ownerInfo: Record<string, string> = {};
  (users || []).forEach((u) => {
    ownerInfo[u.user_id] = u.display_name || u.metadata?.team_name || u.user_id;
  });

  const sorted = [...(rosters || [])].sort((a, b) => a.roster_id - b.roster_id);
  const rosterIdToIdx: Record<number, number> = {};
  const teamNames: string[] = [];
  const userIds: (string | null)[] = [];
  sorted.forEach((r, idx) => {
    rosterIdToIdx[r.roster_id] = idx;
    teamNames.push((r.owner_id && ownerInfo[r.owner_id]) || `Roster ${r.roster_id}`);
    userIds.push(r.owner_id || null);
  });

  const regWeeks = settings?.playoff_week_start ? settings.playoff_week_start - 1 : 14;

  const allPairs: [number, number][] = [];
  for (let week = 1; week <= regWeeks; week++) {
    const matchups = await fetchJson<SleeperMatchup[]>(
      `${BASE}/league/${leagueId}/matchups/${week}`,
    );
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

  return { teamNames, userIds, doubles, totalMatchups: allPairs.length, regWeeks };
}

export async function POST(req: Request) {
  const rl = checkRateLimit(getClientIp(req));
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Retry in ${rl.retryAfter}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let body: { leagueId?: string };
  try {
    body = (await req.json()) as { leagueId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const leagueId = (body.leagueId || "").trim();
  if (!leagueId || !/^\d+$/.test(leagueId)) {
    return NextResponse.json(
      { error: "leagueId is required and must be numeric." },
      { status: 400 },
    );
  }

  try {
    const chain = await discoverChain(leagueId);
    const completed = chain.filter((s) => s.hasData);
    if (completed.length === 0) {
      return NextResponse.json(
        { error: "No completed seasons found in this league's history." },
        { status: 404 },
      );
    }

    const toFetch = completed.slice(0, MAX_SEASONS);
    const results = [];
    for (const target of toFetch) {
      const data = await fetchSeason(target.leagueId, target.settings);
      results.push({
        seasonYear: target.season,
        seasonName: target.name,
        teamNames: data.teamNames,
        userIds: data.userIds,
        doubles: data.doubles,
        totalMatchups: data.totalMatchups,
        regWeeks: data.regWeeks,
      });
    }

    return NextResponse.json(results);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || "Failed to fetch from Sleeper." },
      { status: 502 },
    );
  }
}
