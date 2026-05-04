// ESPN's lm-api-reads endpoint is undocumented and historically prone to
// breaking changes, so the route is permissive about partial failures: if any
// requested season succeeds the route still returns 200, and total failure
// surfaces a message that points the user at the paste-and-parse fallback.
// Public leagues only — private leagues require espn_s2 + SWID cookies, which
// are out of scope for this phase.

import { NextResponse } from "next/server";
import { pairKey } from "@/lib/algorithm";
import type { PairKey } from "@/lib/algorithm";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";
const MAX_SEASONS = 5;
const FALLBACK_HINT = "If this keeps failing, paste your schedule as text below.";

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

async function fetchEspnSeason(leagueId: string, seasonId: number) {
  const url = `${BASE}/${seasonId}/segments/0/leagues/${leagueId}?view=mMatchupScore&view=mTeam`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 401) {
    throw new Error(`Season ${seasonId} is private. Public leagues only for now.`);
  }
  if (res.status === 404) {
    throw new Error(`Season ${seasonId} not found for this league.`);
  }
  if (!res.ok) {
    throw new Error(`ESPN HTTP ${res.status} for season ${seasonId}.`);
  }

  const data = (await res.json()) as EspnLeague;
  if (!Array.isArray(data?.teams) || !Array.isArray(data?.schedule)) {
    throw new Error(`Unexpected ESPN response shape for season ${seasonId}.`);
  }

  const teams = [...data.teams].sort((a, b) => a.id - b.id);
  const teamIdToIdx: Record<number, number> = {};
  const teamNames: string[] = [];
  const userIds: (string | null)[] = [];

  teams.forEach((t, idx) => {
    teamIdToIdx[t.id] = idx;
    const composed = `${t.location || ""} ${t.nickname || ""}`.trim();
    const name = (t.name && String(t.name).trim()) || composed || `Team ${t.id}`;
    teamNames.push(name);
    const owner =
      (typeof t.primaryOwner === "string" && t.primaryOwner) ||
      (Array.isArray(t.owners) && typeof t.owners[0] === "string" && t.owners[0]) ||
      null;
    userIds.push(owner);
  });

  const regSchedule = data.schedule.filter(
    (m) =>
      m &&
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
    seasonName: data.settings?.name || `League ${leagueId}`,
    teamNames,
    userIds,
    doubles,
    totalMatchups: allPairs.length,
    regWeeks,
  };
}

export async function POST(req: Request) {
  const rl = checkRateLimit(getClientIp(req));
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Retry in ${rl.retryAfter}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let body: { leagueId?: string; seasonId?: number };
  try {
    body = (await req.json()) as { leagueId?: string; seasonId?: number };
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

  const startSeason =
    body.seasonId && Number.isFinite(body.seasonId)
      ? Math.floor(body.seasonId)
      : new Date().getFullYear() - 1;

  const results = [];
  const errors: string[] = [];

  for (let i = 0; i < MAX_SEASONS; i++) {
    const year = startSeason - i;
    try {
      const data = await fetchEspnSeason(leagueId, year);
      results.push(data);
    } catch (e) {
      errors.push(`${year}: ${(e as Error).message}`);
    }
  }

  if (results.length === 0) {
    return NextResponse.json(
      {
        error: `Could not fetch any seasons from ESPN. ${errors.join(" | ")}. ${FALLBACK_HINT}`,
      },
      { status: 502 },
    );
  }

  return NextResponse.json(results);
}
