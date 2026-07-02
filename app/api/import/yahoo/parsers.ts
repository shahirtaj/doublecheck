// Parsers for Yahoo Fantasy's nested-array JSON, in a sibling module so they
// can be unit-tested directly (Next.js route files may only export route
// handlers - the same convention as ./chain and the Sleeper/ESPN seasons
// modules).
//
// Yahoo's API encodes single-resource metadata as an array of single-key
// objects: [{"league_key": "..."}, {"name": "..."}, ...]. flattenYahooMeta
// coalesces that quirk into a flat record so the parsers stay readable.
//
// fetchSeasonRecord is the one non-pure export: it builds a season's
// ImportedSeasonRecord from the teams + scoreboard endpoints with the JSON
// fetch injected (the route binds it to fetchYahooJson with the access
// token), so its index mapping and doubles counting test without a network.

import { pairKey } from "@/lib/algorithm";
import type { PairKey } from "@/lib/algorithm";
import type {
  ImportedSeasonRecord,
  YahooLeagueDetails,
  YahooLeagueMeta,
} from "./chain";

export const YAHOO_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";

export type YahooTeam = {
  teamId: number;
  teamKey: string;
  name: string;
  managerGuid: string | null;
};

export type YahooMatchup = {
  week: number;
  isPlayoffs: boolean;
  teamIds: [number, number];
};

export function flattenYahooMeta(input: unknown): Record<string, unknown> {
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

export function buildLeagueKeyFromRenew(renew: unknown): string | null {
  if (typeof renew !== "string" || !renew || renew === "0") return null;
  if (renew.includes(".l.")) return renew;
  if (renew.includes("_")) {
    const [gameKey, leagueId] = renew.split("_");
    if (gameKey && leagueId) return `${gameKey}.l.${leagueId}`;
  }
  return null;
}

export function parseLeaguesList(json: unknown): YahooLeagueMeta[] {
  const result: YahooLeagueMeta[] = [];
  const root = json as Record<string, unknown> | undefined;
  const users = (root?.fantasy_content as Record<string, unknown> | undefined)
    ?.users as Record<string, unknown> | undefined;
  const userArr = (users?.["0"] as Record<string, unknown> | undefined)?.user;
  if (!Array.isArray(userArr)) return result;
  const games = (userArr[1] as Record<string, unknown> | undefined)?.games as
    Record<string, unknown> | undefined;
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
        Record<string, unknown> | undefined;
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
  return Array.from(byName.values()).sort((a, b) => {
    const bySeason = b.season.localeCompare(a.season, undefined, {
      numeric: true,
    });
    return bySeason !== 0
      ? bySeason
      : a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

export function parseLeagueDetails(json: unknown): YahooLeagueDetails | null {
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

export function parseTeams(json: unknown): YahooTeam[] {
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

export function parseScoreboard(json: unknown): YahooMatchup[] {
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
      Record<string, unknown> | undefined;
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
        Record<string, unknown> | undefined;
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

// Builds one season's record from the teams + scoreboard endpoints. The JSON
// fetch is injected so the mapping and doubles logic test without a network;
// the route binds it to fetchYahooJson with the request's access token.
export async function fetchSeasonRecord(
  details: YahooLeagueDetails,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<ImportedSeasonRecord | null> {
  const teamsJson = await fetchJson(
    `${YAHOO_BASE}/league/${details.leagueKey}/teams`,
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
  const sbJson = await fetchJson(
    `${YAHOO_BASE}/league/${details.leagueKey}/scoreboard;week=${weekParam}`,
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
