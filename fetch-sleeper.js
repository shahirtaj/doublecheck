#!/usr/bin/env node

// Usage: node fetch-sleeper.js <league_id> [--backfill]
// Outputs JSON to paste into the Schedule Generator tool.
// Default: fetches the most recent completed season.
// --backfill: fetches the last 3 completed seasons (use after a reset).

const args = process.argv.slice(2);
const BACKFILL = args.includes("--backfill");
const LEAGUE_ID = args.find((a) => !a.startsWith("--"));
if (!LEAGUE_ID) {
  console.error("Usage: node fetch-sleeper.js <league_id> [--backfill]");
  console.error("Find your league ID in the Sleeper URL: sleeper.com/leagues/<ID>");
  process.exit(1);
}

const BASE = "https://api.sleeper.app/v1";

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function pairKey(i, j) {
  return `${Math.min(i, j)}-${Math.max(i, j)}`;
}

async function discoverChain(leagueId) {
  const seasons = [];
  let currentId = leagueId;

  for (let depth = 0; depth < 5; depth++) {
    process.stderr.write(`Discovering season ${depth + 1}...\n`);
    const league = await fetchJSON(`${BASE}/league/${currentId}`);
    if (!league?.league_id) break;

    const week1 = await fetchJSON(`${BASE}/league/${currentId}/matchups/1`);
    const hasData = Array.isArray(week1) && week1.some((m) => m.matchup_id != null && m.points > 0);

    seasons.push({ leagueId: league.league_id, name: league.name, season: league.season, hasData, settings: league.settings, previousLeagueId: league.previous_league_id });

    if (!league.previous_league_id) break;
    currentId = league.previous_league_id;
  }
  return seasons;
}

async function fetchSeason(leagueId, settings) {
  const users = await fetchJSON(`${BASE}/league/${leagueId}/users`);
  const rosters = await fetchJSON(`${BASE}/league/${leagueId}/rosters`);

  const ownerInfo = {};
  (users || []).forEach((u) => {
    ownerInfo[u.user_id] = u.display_name || u.metadata?.team_name || u.user_id;
  });

  const sorted = [...rosters].sort((a, b) => a.roster_id - b.roster_id);
  const rosterIdToIdx = {};
  const teamNames = [];
  const userIds = [];
  sorted.forEach((r, idx) => {
    rosterIdToIdx[r.roster_id] = idx;
    teamNames.push(ownerInfo[r.owner_id] || `Roster ${r.roster_id}`);
    userIds.push(r.owner_id || null);
  });

  const regWeeks = settings?.playoff_week_start ? settings.playoff_week_start - 1 : 14;

  const allPairs = [];
  for (let week = 1; week <= regWeeks; week++) {
    process.stderr.write(`  Fetching week ${week}/${regWeeks}...\n`);
    const matchups = await fetchJSON(`${BASE}/league/${leagueId}/matchups/${week}`);
    if (!Array.isArray(matchups)) continue;
    const groups = {};
    matchups.forEach((m) => {
      if (m.matchup_id == null) return;
      if (!groups[m.matchup_id]) groups[m.matchup_id] = [];
      groups[m.matchup_id].push(m.roster_id);
    });
    Object.values(groups).forEach((pair) => {
      if (pair.length === 2) {
        const a = rosterIdToIdx[pair[0]];
        const b = rosterIdToIdx[pair[1]];
        if (a !== undefined && b !== undefined) allPairs.push([a, b]);
      }
    });
  }

  // Detect doubles
  const counts = {};
  allPairs.forEach(([a, b]) => {
    const k = pairKey(a, b);
    counts[k] = (counts[k] || 0) + 1;
  });
  const doubles = Object.entries(counts).filter(([, v]) => v > 1).map(([k]) => k);

  return { teamNames, userIds, doubles, totalMatchups: allPairs.length, regWeeks };
}

async function main() {
  process.stderr.write(`Fetching league ${LEAGUE_ID}...\n\n`);

  const chain = await discoverChain(LEAGUE_ID);
  const withData = chain.filter((s) => s.hasData);

  if (withData.length === 0) {
    console.error("No completed seasons found.");
    process.exit(1);
  }

  process.stderr.write(`\nFound ${withData.length} completed season(s):\n`);
  withData.forEach((s) => process.stderr.write(`  ${s.season} — ${s.name}\n`));

  // Fetch 1 season normally, 2 with --backfill
  const toFetch = withData.slice(0, BACKFILL ? 3 : 1);
  const seasons = [];

  for (const target of toFetch) {
    process.stderr.write(`\nImporting ${target.season} season...\n`);
    const data = await fetchSeason(target.leagueId, target.settings);
    seasons.push({
      seasonYear: target.season,
      seasonName: target.name,
      teamNames: data.teamNames,
      userIds: data.userIds,
      doubles: data.doubles,
      totalMatchups: data.totalMatchups,
      regWeeks: data.regWeeks,
    });
  }

  // Output JSON to stdout (progress goes to stderr so piping works)
  console.log(JSON.stringify(seasons, null, 2));

  process.stderr.write(`\nDone! Fetched ${seasons.length} season(s).\n`);
  process.stderr.write(`Copy the JSON output above and paste it into the Schedule Generator tool.\n`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
