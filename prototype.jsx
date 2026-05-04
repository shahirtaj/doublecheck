import { useState, useEffect, useCallback } from "react";

const N = 12;

// ── Utilities ──────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pairKey(i, j) {
  return `${Math.min(i, j)}-${Math.max(i, j)}`;
}

// ── Schedule Paste Parser ──────────────────────────────────

function parseScheduleText(text, teamNames) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const rawPairs = [];
  const seps = [" vs. ", " vs ", " @ ", " at ", " - ", " v "];

  for (const line of lines) {
    if (/^(week|round|wk)\s*\d+/i.test(line)) continue;
    if (/^-+$/.test(line)) continue;

    let matched = false;
    for (const sep of seps) {
      const idx = line.toLowerCase().indexOf(sep.toLowerCase());
      if (idx !== -1) {
        let a = line.slice(0, idx).trim();
        let b = line.slice(idx + sep.length).trim();
        a = a.replace(/\s+\d+(\.\d+)?$/, "").replace(/\s*\(.*?\)\s*$/, "").trim();
        b = b.replace(/^\d+(\.\d+)?\s+/, "").replace(/\s+\d+(\.\d+)?$/, "").replace(/\s*\(.*?\)\s*$/, "").trim();
        if (a && b) {
          rawPairs.push([a, b]);
          matched = true;
        }
        break;
      }
    }

    if (!matched && line.includes("\t")) {
      const parts = line.split("\t").map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        rawPairs.push([parts[0].replace(/\s+\d+(\.\d+)?$/, "").trim(), parts[1].replace(/\s+\d+(\.\d+)?$/, "").trim()]);
      }
    }
  }

  if (rawPairs.length === 0) return { success: false, error: "No matchups found. Use a format like 'Team A vs Team B', one per line." };

  const uniqueNames = [...new Set(rawPairs.flat())];
  const nameToIndex = {};
  const unmapped = [];

  for (const name of uniqueNames) {
    let idx = teamNames.findIndex((t) => t.toLowerCase() === name.toLowerCase());
    if (idx === -1) {
      idx = teamNames.findIndex(
        (t) => t.length >= 3 && (name.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(name.toLowerCase()))
      );
    }
    if (idx !== -1 && !Object.values(nameToIndex).includes(idx)) {
      nameToIndex[name] = idx;
    } else if (idx === -1) {
      unmapped.push(name);
    }
  }

  return { success: true, rawPairs, uniqueNames, nameToIndex, unmapped };
}

function detectDoublesFromPairs(indexedPairs) {
  const counts = {};
  indexedPairs.forEach(([a, b]) => {
    const k = pairKey(a, b);
    counts[k] = (counts[k] || 0) + 1;
  });
  return new Set(Object.entries(counts).filter(([, v]) => v > 1).map(([k]) => k));
}

// ── Sleeper API Integration ────────────────────────────────

async function discoverSleeperChain(leagueId, onStatus) {
  const base = "https://api.sleeper.app/v1";
  const seasons = [];
  let currentId = leagueId;

  for (let depth = 0; depth < 5; depth++) {
    onStatus(`Discovering seasons… (${seasons.length} found)`);
    const res = await fetch(`${base}/league/${currentId}`);
    if (!res.ok) break;
    const league = await res.json();
    if (!league?.league_id) break;

    // Quick check for matchup data
    const week1 = await fetch(`${base}/league/${currentId}/matchups/1`).then((r) => r.json());
    const hasData = Array.isArray(week1) && week1.some((m) => m.matchup_id != null && m.points > 0);

    seasons.push({
      leagueId: league.league_id,
      name: league.name || leagueId,
      season: league.season || "",
      hasData,
      settings: league.settings,
      previousLeagueId: league.previous_league_id,
    });

    if (!league.previous_league_id) break;
    currentId = league.previous_league_id;
  }

  return seasons;
}

async function fetchSleeperSeason(leagueId, settings, onStatus) {
  const base = "https://api.sleeper.app/v1";

  onStatus("Fetching managers…");
  const users = await fetch(`${base}/league/${leagueId}/users`).then((r) => r.json());
  const rosters = await fetch(`${base}/league/${leagueId}/rosters`).then((r) => r.json());

  if (!Array.isArray(rosters) || rosters.length !== N) {
    throw new Error(`Expected ${N} teams but found ${rosters?.length || 0}.`);
  }

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

  onStatus(`Fetching ${regWeeks} weeks of matchups…`);
  const allPairs = [];
  for (let week = 1; week <= regWeeks; week++) {
    const matchups = await fetch(`${base}/league/${leagueId}/matchups/${week}`).then((r) => r.json());
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

  const doubles = detectDoublesFromPairs(allPairs);

  return { teamNames, userIds, doubles, totalMatchups: allPairs.length, regWeeks };
}

// ── Scheduling Algorithm ───────────────────────────────────

function findPerfectMatching(n, available, softAvoid) {
  const matching = [];
  const paired = new Set();
  function backtrack() {
    if (paired.size === n) return true;
    let team = -1;
    for (let i = 0; i < n; i++) {
      if (!paired.has(i)) { team = i; break; }
    }
    let partners = Array.from({ length: n }, (_, i) => i).filter(
      (j) => j !== team && !paired.has(j) && available.has(pairKey(team, j))
    );
    // Prefer non-soft-avoided edges (fresh pairs first, N-3 pairs last)
    if (softAvoid && softAvoid.size > 0) {
      const preferred = partners.filter((j) => !softAvoid.has(pairKey(team, j)));
      const deprioritized = partners.filter((j) => softAvoid.has(pairKey(team, j)));
      partners = [...shuffle(preferred), ...shuffle(deprioritized)];
    } else {
      partners = shuffle(partners);
    }
    for (const p of partners) {
      paired.add(team);
      paired.add(p);
      matching.push([Math.min(team, p), Math.max(team, p)]);
      if (backtrack()) return true;
      paired.delete(team);
      paired.delete(p);
      matching.pop();
    }
    return false;
  }
  return backtrack() ? matching : null;
}

function tryGenerateDoubles(n, avoidSet, softAvoid) {
  const allEdges = new Set();
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (!avoidSet.has(pairKey(i, j))) allEdges.add(pairKey(i, j));

  for (let attempt = 0; attempt < 150; attempt++) {
    const matchings = [];
    const used = new Set();
    let ok = true;
    for (let m = 0; m < 3; m++) {
      const avail = new Set([...allEdges].filter((e) => !used.has(e)));
      const matching = findPerfectMatching(n, avail, softAvoid);
      if (!matching) { ok = false; break; }
      matchings.push(matching);
      matching.forEach(([a, b]) => used.add(pairKey(a, b)));
    }
    if (ok) return matchings;
  }
  return null;
}

function decomposeSinglePairs(n, doubledPairs) {
  // Decompose the 48 non-doubled pairs into 8 perfect matchings.
  // The complement of a 3-regular graph is 8-regular, always decomposable.
  for (let attempt = 0; attempt < 200; attempt++) {
    const remaining = new Set();
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (!doubledPairs.has(pairKey(i, j))) remaining.add(pairKey(i, j));

    const matchings = [];
    let success = true;
    for (let m = 0; m < 8; m++) {
      const matching = findPerfectMatching(n, remaining);
      if (!matching) { success = false; break; }
      matchings.push(matching);
      matching.forEach(([a, b]) => remaining.delete(pairKey(a, b)));
    }
    if (success) return matchings;
  }
  return null;
}

function buildSchedule(n, hardAvoid, softAvoid) {
  const allAvoid = new Set([...hardAvoid, ...softAvoid]);

  // Tier 1: try avoiding all 3 years (usually fails — too constrained)
  let doubleMatchings = tryGenerateDoubles(n, allAvoid);
  let clean = true;

  // Tier 2: hard-avoid N-1/N-2, deprioritize N-3 pairs
  if (!doubleMatchings) {
    doubleMatchings = tryGenerateDoubles(n, hardAvoid, softAvoid);
    clean = false;
  }

  // Tier 3: safety fallback
  if (!doubleMatchings) {
    doubleMatchings = tryGenerateDoubles(n, new Set());
    clean = false;
  }

  if (!doubleMatchings) return null;

  const doubled = new Set();
  doubleMatchings.forEach((m) => m.forEach(([a, b]) => doubled.add(pairKey(a, b))));

  const singleMatchings = decomposeSinglePairs(n, doubled);
  if (!singleMatchings) return null;

  const doubleOrder = shuffle([0, 1, 2]);
  const shuffledSingles = shuffle(singleMatchings);

  const allRounds = [];
  for (const i of doubleOrder) allRounds.push(doubleMatchings[i]);
  for (const s of shuffledSingles) allRounds.push(s);
  for (const i of doubleOrder) allRounds.push(doubleMatchings[i]);

  // Track which soft-avoid pairs were repeated
  const softRepeated = [];
  doubled.forEach((key) => {
    if (softAvoid.has(key)) softRepeated.push(key);
  });

  const hardRepeated = [];
  if (!clean) {
    doubled.forEach((key) => {
      if (hardAvoid.has(key)) hardRepeated.push(key);
    });
  }

  return { weeks: allRounds, doubledPairs: doubled, softRepeated, hardRepeated, clean };
}

// ── Build avoidance map from history ───────────────────────

function buildAvoidMap(history, currentUserIds) {
  const hard = new Set();
  const soft = new Set();
  const len = history.length;
  if (len === 0) return { hard, soft };

  // Build userId → current index lookup
  const uidToIdx = {};
  if (currentUserIds) {
    currentUserIds.forEach((uid, idx) => {
      if (uid) uidToIdx[uid] = idx;
    });
  }

  history.forEach((season, idx) => {
    const age = len - idx;
    if (age > 3) return; // look back 3 seasons

    (season.doubles || []).forEach((key) => {
      let resolvedKey = key;

      if (season.format === "userid") {
        const [uid1, uid2] = key.split(":");
        const i1 = uidToIdx[uid1];
        const i2 = uidToIdx[uid2];
        if (i1 === undefined || i2 === undefined) return;
        resolvedKey = pairKey(i1, i2);
      }

      // N-1 and N-2: hard avoid. N-3: soft avoid (deprioritized, not blocked).
      if (age <= 2) hard.add(resolvedKey);
      else soft.add(resolvedKey);
    });
  });

  // Remove from soft anything already in hard (no double-counting)
  hard.forEach((key) => soft.delete(key));

  return { hard, soft };
}

// ── Component ──────────────────────────────────────────────

const STORAGE_KEY = "ff-rotational-scheduler";

export default function FFScheduler() {
  const [step, setStep] = useState("teams");
  const [teams, setTeams] = useState(Array(N).fill("").map((_, i) => `Team ${i + 1}`));
  const [userIds, setUserIds] = useState(Array(N).fill(null));
  const [manualDoubles, setManualDoubles] = useState(new Set());
  const [schedule, setSchedule] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [genError, setGenError] = useState("");
  const [selectedWeek, setSelectedWeek] = useState(0);
  const [saved, setSaved] = useState(false);

  const [pasteText, setPasteText] = useState("");
  const [parseResult, setParseResult] = useState(null);
  const [nameMapping, setNameMapping] = useState({});
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // Sleeper integration state
  const [sleeperId, setSleeperId] = useState("");
  const [sleeperJson, setSleeperJson] = useState("");
  const [sleeperStatus, setSleeperStatus] = useState(""); // "", "loading", "discovered", "importing", "error"
  const [sleeperMsg, setSleeperMsg] = useState("");
  const [sleeperSeasons, setSleeperSeasons] = useState([]); // discovered chain
  const [sleeperData, setSleeperData] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get(STORAGE_KEY);
        if (r) {
          const d = JSON.parse(r.value);
          if (d.teams?.length === N) setTeams(d.teams);
          if (d.userIds?.length === N) setUserIds(d.userIds);
          if (d.history) setHistory(d.history);
          if (d.manualDoubles) setManualDoubles(new Set(d.manualDoubles));
        }
      } catch (e) {}
      setLoading(false);
    })();
  }, []);

  const saveToStorage = useCallback(
    async (extra = {}) => {
      try {
        await window.storage.set(
          STORAGE_KEY,
          JSON.stringify({ teams, userIds, history, manualDoubles: [...manualDoubles], ...extra })
        );
      } catch (e) {}
    },
    [teams, userIds, history, manualDoubles]
  );

  function getAvoidSets() {
    const { hard, soft } = buildAvoidMap(history, userIds);
    manualDoubles.forEach((key) => {
      hard.add(key);
      soft.delete(key);
    });
    return { hard, soft };
  }

  function handleGenerate() {
    setGenError("");
    setSaved(false);
    const { hard, soft } = getAvoidSets();
    const result = buildSchedule(N, hard, soft);
    if (!result) {
      setGenError("Could not generate a valid schedule. Try clearing some avoid-pairs.");
      return;
    }
    setSchedule(result);
    setSelectedWeek(0);
    setStep("schedule");
  }

  async function handleSaveSeason() {
    if (!schedule) return;
    const currentYear = new Date().getFullYear();
    const lastYear = history.length > 0 ? parseInt(history[history.length - 1].season) : currentYear - 1;
    const seasonLabel = String(Math.max(currentYear, isNaN(lastYear) ? currentYear : lastYear + 1));
    const hasUserIds = userIds.some((id) => id != null);

    let doubles, format;
    if (hasUserIds) {
      doubles = [...schedule.doubledPairs].map((key) => {
        const [a, b] = key.split("-").map(Number);
        return [userIds[a], userIds[b]].sort().join(":");
      });
      format = "userid";
    } else {
      doubles = [...schedule.doubledPairs];
      format = "index";
    }

    const entry = { season: seasonLabel, doubles, format };
    const newHistory = [...history, entry];
    setHistory(newHistory);
    setManualDoubles(new Set());
    await saveToStorage({ history: newHistory, manualDoubles: [] });
    setSaved(true);
  }

  function toggleDouble(i, j) {
    const key = pairKey(i, j);
    const next = new Set(manualDoubles);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setManualDoubles(next);
  }

  function handleParse() {
    const result = parseScheduleText(pasteText, teams);
    setParseResult(result);
    if (result.success) setNameMapping(result.nameToIndex);
  }

  function handleApplyParsed() {
    if (!parseResult?.success) return;
    const indexedPairs = [];
    for (const [a, b] of parseResult.rawPairs) {
      const ai = nameMapping[a];
      const bi = nameMapping[b];
      if (ai !== undefined && bi !== undefined && ai !== bi) indexedPairs.push([ai, bi]);
    }
    const doubles = detectDoublesFromPairs(indexedPairs);
    setManualDoubles(doubles);
    setParseResult(null);
    setPasteText("");
  }

  function allParsedNamesMapped() {
    if (!parseResult?.success) return false;
    return parseResult.uniqueNames.every((name) => nameMapping[name] !== undefined);
  }

  // ── Sleeper handlers ──

  async function handleSleeperFetch() {
    if (!sleeperId.trim()) return;
    setSleeperStatus("loading");
    setSleeperMsg("Discovering league history…");
    setSleeperSeasons([]);
    setSleeperData(null);
    try {
      const seasons = await discoverSleeperChain(sleeperId.trim(), setSleeperMsg);
      if (seasons.length === 0) throw new Error("League not found.");
      const withData = seasons.filter((s) => s.hasData);
      if (withData.length === 0) throw new Error("No completed seasons found in this league's history.");
      setSleeperSeasons(seasons);
      setSleeperStatus("discovered");
      setSleeperMsg(`Found ${withData.length} completed season${withData.length > 1 ? "s" : ""} in league history.`);
    } catch (e) {
      setSleeperStatus("error");
      const msg = e.message || "Unknown error";
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("CORS")) {
        setSleeperMsg("Network error — Sleeper's API may block browser requests. Use the paste method below instead.");
      } else {
        setSleeperMsg(msg);
      }
    }
  }

  async function handleSleeperImportSeason(seasonInfo) {
    setSleeperStatus("importing");
    setSleeperMsg(`Importing ${seasonInfo.season} season…`);
    try {
      const data = await fetchSleeperSeason(seasonInfo.leagueId, seasonInfo.settings, setSleeperMsg);
      setSleeperData({ ...data, seasonName: seasonInfo.name, seasonYear: seasonInfo.season });
      setSleeperStatus("imported");
      setSleeperMsg(`Imported ${seasonInfo.season}: ${data.totalMatchups} matchups, ${data.doubles.size} doubled pairs.`);
    } catch (e) {
      setSleeperStatus("error");
      setSleeperMsg(e.message || "Import failed.");
    }
  }

  async function handleSleeperBackfill() {
    const withData = sleeperSeasons.filter((s) => s.hasData);
    // Import oldest first so history order is chronological
    const toImport = withData.slice(0, 3).reverse();
    setSleeperStatus("importing");

    const mostRecent = withData[0];
    let latestData = null;

    for (let i = 0; i < toImport.length; i++) {
      const s = toImport[i];
      setSleeperMsg(`Importing ${s.season} season… (${i + 1}/${toImport.length})`);
      try {
        const data = await fetchSleeperSeason(s.leagueId, s.settings, setSleeperMsg);
        const doubles = [...data.doubles].map((key) => {
          const [a, b] = key.split("-").map(Number);
          return [data.userIds[a], data.userIds[b]].sort().join(":");
        });
        const entry = { season: s.season, doubles, format: "userid" };
        setHistory((prev) => [...prev, entry]);
        if (s === mostRecent) latestData = data;
      } catch (e) {
        setSleeperMsg(`Failed on ${s.season}: ${e.message}. Earlier seasons were saved.`);
        setSleeperStatus("error");
        return;
      }
    }

    // Apply the most recent season's data for team names + userIds
    if (latestData) {
      setTeams(latestData.teamNames);
      setUserIds(latestData.userIds);
    }

    // Save everything to storage
    setHistory((prev) => {
      saveToStorage({ history: prev, manualDoubles: [] });
      return prev;
    });

    setSleeperStatus("backfilled");
    setSleeperMsg(`Backfilled ${toImport.length} seasons into history. Ready to generate.`);
  }

  function handleSleeperApply() {
    if (!sleeperData) return;
    const hasCustomNames = teams.some((t, i) => t !== `Team ${i + 1}`);
    if (!hasCustomNames) {
      setTeams(sleeperData.teamNames);
    }
    setUserIds(sleeperData.userIds);

    // Build history entries from imported data
    const seasonsToImport = sleeperData.allSeasons
      ? [...sleeperData.allSeasons].reverse()  // oldest first
      : [sleeperData];

    const newHistory = [...history];

    for (const season of seasonsToImport) {
      const sUserIds = season.userIds || sleeperData.userIds;
      const hasUids = sUserIds.some((id) => id != null);
      const sDoubles = season.doubles instanceof Set ? [...season.doubles] : season.doubles;
      let importDoubles;
      if (hasUids) {
        importDoubles = sDoubles.map((key) => {
          const [a, b] = key.split("-").map(Number);
          return [sUserIds[a], sUserIds[b]].sort().join(":");
        });
      } else {
        importDoubles = sDoubles;
      }

      // Dedup: skip if most recent history entry has the same doubles
      const lastEntry = newHistory[newHistory.length - 1];
      const lastDoubles = lastEntry ? [...lastEntry.doubles].sort().join(",") : "";
      const newDoubles = [...importDoubles].sort().join(",");
      if (lastDoubles !== newDoubles) {
        newHistory.push({
          season: season.seasonYear || String(new Date().getFullYear() - 1),
          doubles: importDoubles,
          format: hasUids ? "userid" : "index",
        });
      }
    }

    setHistory(newHistory);
    saveToStorage({ history: newHistory });

    setManualDoubles(new Set());
    setSleeperStatus("");
    setSleeperMsg("");
    setSleeperData(null);
    setSleeperSeasons([]);
    setSleeperId("");
  }

  function resetSleeper() {
    setSleeperStatus("");
    setSleeperMsg("");
    setSleeperData(null);
    setSleeperSeasons([]);
  }

  function handleJsonImport() {
    try {
      const raw = JSON.parse(sleeperJson);
      // Accept either a single season object or an array of seasons
      const seasons = Array.isArray(raw) ? raw : [raw];

      if (seasons.length === 0) throw new Error("No season data found.");
      for (const s of seasons) {
        if (!s.teamNames || !s.userIds || !s.doubles) {
          throw new Error("Missing required fields (teamNames, userIds, doubles).");
        }
        if (s.teamNames.length !== N) {
          throw new Error(`Expected ${N} teams but found ${s.teamNames.length}.`);
        }
      }

      // Use the most recent season (first in array) for team names / display
      const primary = seasons[0];
      const doublesSet = new Set(primary.doubles);
      setSleeperData({
        teamNames: primary.teamNames,
        userIds: primary.userIds,
        doubles: doublesSet,
        regWeeks: primary.regWeeks || 14,
        seasonYear: primary.seasonYear || "",
        // Pass all seasons for bulk history import
        allSeasons: seasons,
      });
      setSleeperStatus("imported");
      const label = seasons.length > 1
        ? `Imported ${seasons.length} seasons from JSON (${seasons.map((s) => s.seasonYear).join(", ")}).`
        : `Imported from JSON: ${primary.doubles.length} doubled pairs (${primary.seasonYear || "unknown season"}).`;
      setSleeperMsg(label);
      setSleeperJson("");
    } catch (e) {
      setSleeperStatus("error");
      setSleeperMsg(`JSON parse error: ${e.message}`);
    }
  }

  function getAvoidDisplay() {
    const { hard, soft } = getAvoidSets();
    return { hard: hard.size, soft: soft.size, total: hard.size + soft.size };
  }

  function doublesPerTeam() {
    const counts = Array(N).fill(0);
    manualDoubles.forEach((key) => {
      const [a, b] = key.split("-").map(Number);
      counts[a]++;
      counts[b]++;
    });
    return counts;
  }

  function abbrev(name) {
    return name.length > 5 ? name.slice(0, 5) : name;
  }

  function cellAvoidType(i, j) {
    const key = pairKey(i, j);
    if (manualDoubles.has(key)) return "manual";
    const { hard, soft } = buildAvoidMap(history, userIds);
    if (hard.has(key)) return "hard";
    if (soft.has(key)) return "soft";
    return "none";
  }

  if (loading) {
    return (
      <div style={S.container}>
        <p style={{ color: "#94a3b8", textAlign: "center", marginTop: 80 }}>Loading…</p>
      </div>
    );
  }

  const avoidInfo = getAvoidDisplay();

  return (
    <div style={S.container}>
      <div style={S.header}>
        <h1 style={S.title}>Schedule Generator</h1>
        <p style={S.subtitle}>14-week rotational scheduling · 12-team leagues</p>
      </div>

      <div style={S.nav}>
        {[["teams", "1 · Import"], ["doubles", "2 · Review"], ["schedule", "3 · Schedule"]].map(([key, label]) => (
          <button key={key} onClick={() => setStep(key)} style={{ ...S.navBtn, ...(step === key ? S.navBtnActive : {}) }}>
            {label}
          </button>
        ))}
      </div>

      {/* ═══ STEP 1: IMPORT ═══ */}
      {step === "teams" && (
        <div style={S.card}>
          <h2 style={S.cardTitle}>Import Last Season</h2>

          {/* Sleeper import */}
          <div style={S.pasteSection}>
            <h3 style={S.sectionTitle}>Import from Sleeper</h3>
            <p style={S.hint}>
              Enter your current Sleeper league ID — the tool walks the history chain to find completed seasons.
              Find it in your league URL: sleeper.com/leagues/<strong>YOUR_ID</strong>
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                style={{ ...S.teamInput, background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "8px 10px", flex: 1 }}
                value={sleeperId}
                onChange={(e) => { setSleeperId(e.target.value); resetSleeper(); }}
                placeholder="e.g. 924039458279227392"
              />
              <button
                style={S.primaryBtn}
                onClick={handleSleeperFetch}
                disabled={!sleeperId.trim() || sleeperStatus === "loading" || sleeperStatus === "importing"}
              >
                {sleeperStatus === "loading" ? "Searching…" : "Fetch"}
              </button>
            </div>

            {sleeperMsg && (
              <p style={{ fontSize: 11, marginTop: 8, color: sleeperStatus === "error" ? "#f87171" : sleeperStatus === "backfilled" || sleeperStatus === "imported" ? "#34d399" : "#94a3b8" }}>
                {sleeperMsg}
              </p>
            )}

            {/* Discovered seasons list */}
            {sleeperStatus === "discovered" && sleeperSeasons.length > 0 && (
              <div style={{ marginTop: 10, padding: "10px 12px", background: "#1e293b", borderRadius: 6, border: "1px solid #334155" }}>
                <p style={{ fontSize: 12, color: "#e2e8f0", margin: "0 0 8px" }}>Seasons found:</p>
                {sleeperSeasons.map((s, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderBottom: i < sleeperSeasons.length - 1 ? "1px solid #334155" : "none" }}>
                    <span style={{ fontSize: 12, color: s.hasData ? "#e2e8f0" : "#475569", flex: 1 }}>
                      {s.season} — {s.name}
                      {!s.hasData && <span style={{ color: "#475569", marginLeft: 6 }}>(no data)</span>}
                    </span>
                    {s.hasData && (
                      <button
                        style={{ ...S.secondaryBtn, padding: "4px 10px", fontSize: 11 }}
                        onClick={() => handleSleeperImportSeason(s)}
                      >
                        Import
                      </button>
                    )}
                  </div>
                ))}
                {sleeperSeasons.filter((s) => s.hasData).length >= 2 && (
                  <div style={{ marginTop: 10 }}>
                    <button style={S.primaryBtn} onClick={handleSleeperBackfill}>
                      Backfill All ({sleeperSeasons.filter((s) => s.hasData).length} seasons → history)
                    </button>
                    <p style={{ fontSize: 10, color: "#64748b", margin: "6px 0 0" }}>
                      Imports all completed seasons into history at once. Sets manager names from the most recent season.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Single season import result */}
            {sleeperData && sleeperStatus === "imported" && (
              <div style={{ marginTop: 10, padding: "10px 12px", background: "#1e293b", borderRadius: 6, border: "1px solid #334155" }}>
                <p style={{ fontSize: 12, color: "#e2e8f0", margin: "0 0 4px" }}>
                  Managers: {sleeperData.teamNames.join(", ")}
                </p>
                <p style={{ fontSize: 12, color: "#34d399", margin: "0 0 10px" }}>
                  {sleeperData.doubles.size} doubled pairs detected across {sleeperData.regWeeks} weeks ({sleeperData.seasonYear}).
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button style={S.primaryBtn} onClick={() => handleSleeperApply()}>
                    Apply
                  </button>
                  <span style={{ fontSize: 10, color: "#64748b" }}>
                    {teams.some((t, i) => t !== `Team ${i + 1}`) ? "Keeps your custom names" : "Imports Sleeper usernames"}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* JSON paste fallback */}
          <details style={{ ...S.details, marginTop: 8 }}>
            <summary style={S.summary}>Paste Sleeper JSON (if live fetch is blocked)</summary>
            <div style={{ ...S.pasteSection, marginTop: 8 }}>
              <p style={S.hint}>
                Run <code style={{ color: "#e2e8f0", background: "#0f172a", padding: "1px 5px", borderRadius: 3 }}>node fetch-sleeper.js YOUR_LEAGUE_ID</code> and paste the output here.
              </p>
              <textarea
                style={S.pasteBox}
                value={sleeperJson}
                onChange={(e) => { setSleeperJson(e.target.value); }}
                placeholder='Paste JSON output from fetch-sleeper.js...'
                rows={4}
              />
              <button style={S.secondaryBtn} onClick={handleJsonImport} disabled={!sleeperJson.trim()}>
                Import JSON
              </button>
            </div>
          </details>

          <div style={S.divider}><span style={S.dividerText}>manager names</span></div>

          <p style={S.hint}>Auto-filled by Sleeper import, or enter manually. Overwrite with real names if you prefer those over usernames.</p>
          <div style={S.teamGrid}>
            {teams.map((t, i) => (
              <div key={i} style={S.teamInputWrap}>
                <span style={S.teamNum}>{i + 1}</span>
                <input
                  style={S.teamInput}
                  value={t}
                  onChange={(e) => { const next = [...teams]; next[i] = e.target.value; setTeams(next); }}
                  placeholder={`Team ${i + 1}`}
                  maxLength={24}
                />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
            <button style={S.primaryBtn} onClick={() => { saveToStorage(); setStep("doubles"); }}>Next →</button>
          </div>
        </div>
      )}

      {/* ═══ STEP 2: AVOID ═══ */}
      {step === "doubles" && (
        <div style={S.card}>
          <h2 style={S.cardTitle}>Review Avoidance</h2>

          {history.length > 0 && (
            <div style={S.lookbackBox}>
              <strong style={{ color: "#e2e8f0" }}>Lookback Active</strong>
              <p style={{ margin: "4px 0 0", fontSize: 11, color: "#94a3b8" }}>
                {history.length} season{history.length > 1 ? "s" : ""} in history.{" "}
                <span style={{ color: "#f87171" }}>■</span> Last 2 seasons = hard avoid{" "}
                {history.length >= 3 && <><span style={{ color: "#fbbf24" }}>■</span> 3rd season = soft avoid</>}
                {" · "}Older seasons rotate out.
              </p>
              <p style={{ margin: "4px 0 0", fontSize: 11, color: "#64748b" }}>
                {avoidInfo.hard} hard · {avoidInfo.soft} soft · {avoidInfo.total} total
              </p>
            </div>
          )}

          {/* Paste fallback */}
          <details style={S.details}>
            <summary style={S.summary}>Paste schedule text (non-Sleeper leagues)</summary>
            <div style={{ ...S.pasteSection, marginTop: 8 }}>
              <p style={S.hint}>
                Paste from ESPN, Yahoo, etc. — "Team A vs Team B" per line. Scores and week headers are stripped automatically.
              </p>
            <textarea
              style={S.pasteBox}
              value={pasteText}
              onChange={(e) => { setPasteText(e.target.value); setParseResult(null); }}
              placeholder={"Week 1\nTeam Alpha vs Team Beta\nTeam Gamma vs Team Delta\n...\n\nWeek 2\nTeam Alpha vs Team Gamma\n..."}
              rows={6}
            />
            <button style={S.secondaryBtn} onClick={handleParse} disabled={!pasteText.trim()}>Parse Schedule</button>

            {parseResult && !parseResult.success && <p style={S.error}>{parseResult.error}</p>}

            {parseResult?.success && (
              <div style={S.parseResults}>
                <p style={{ fontSize: 12, color: "#e2e8f0", margin: 0 }}>
                  Found <strong>{parseResult.rawPairs.length}</strong> matchups across <strong>{parseResult.uniqueNames.length}</strong> teams.
                </p>

                {parseResult.unmapped.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <p style={{ fontSize: 11, color: "#fbbf24", margin: "0 0 6px" }}>
                      {parseResult.unmapped.length} name(s) couldn't auto-match. Map them below:
                    </p>
                    {parseResult.unmapped.map((name) => (
                      <div key={name} style={S.mapRow}>
                        <span style={{ color: "#e2e8f0", fontSize: 12, minWidth: 120 }}>"{name}"</span>
                        <span style={{ color: "#475569", fontSize: 12 }}>→</span>
                        <select
                          style={S.mapSelect}
                          value={nameMapping[name] ?? ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setNameMapping((prev) => ({ ...prev, [name]: val === "" ? undefined : parseInt(val) }));
                          }}
                        >
                          <option value="">— select —</option>
                          {teams.map((t, idx) => {
                            const taken = Object.entries(nameMapping).some(([k, v]) => v === idx && k !== name);
                            return <option key={idx} value={idx} disabled={taken}>{t}{taken ? " (taken)" : ""}</option>;
                          })}
                        </select>
                      </div>
                    ))}
                  </div>
                )}

                {allParsedNamesMapped() && (
                  <div style={{ marginTop: 10 }}>
                    {(() => {
                      const indexedPairs = [];
                      for (const [a, b] of parseResult.rawPairs) {
                        const ai = nameMapping[a], bi = nameMapping[b];
                        if (ai !== undefined && bi !== undefined && ai !== bi) indexedPairs.push([ai, bi]);
                      }
                      const doubles = detectDoublesFromPairs(indexedPairs);
                      return <p style={{ fontSize: 12, color: "#34d399", margin: 0 }}>Detected <strong>{doubles.size}</strong> doubled pairs ready to apply.</p>;
                    })()}
                    <button style={{ ...S.primaryBtn, marginTop: 8 }} onClick={handleApplyParsed}>Apply to Matrix ↓</button>
                  </div>
                )}
              </div>
            )}
          </div>
          </details>

          {/* Matrix */}
          <div style={S.matrixWrap}>
            <div style={S.matrix}>
              <div style={S.matrixRow}>
                <div style={{ ...S.matrixCell, ...S.matrixHeader }}></div>
                {teams.map((t, i) => (
                  <div key={i} style={{ ...S.matrixCell, ...S.matrixHeader }}>{abbrev(t)}</div>
                ))}
              </div>
              {teams.map((t, i) => (
                <div key={i} style={S.matrixRow}>
                  <div style={{ ...S.matrixCell, ...S.matrixHeader }}>{abbrev(t)}</div>
                  {teams.map((_, j) => {
                    if (j <= i) return <div key={j} style={{ ...S.matrixCell, ...S.matrixEmpty }} />;
                    const at = cellAvoidType(i, j);
                    const isManual = manualDoubles.has(pairKey(i, j));
                    return (
                      <div
                        key={j}
                        onClick={() => toggleDouble(i, j)}
                        style={{
                          ...S.matrixCell, ...S.matrixClickable,
                          ...(isManual ? S.matrixManual : at === "hard" ? S.matrixHard : at === "soft" ? S.matrixSoft : {}),
                        }}
                      >
                        {isManual ? "✕" : at === "hard" ? "H" : at === "soft" ? "S" : ""}
                      </div>
                    );
                  })}
                </div>
              ))}
              <div style={S.matrixRow}>
                <div style={{ ...S.matrixCell, ...S.matrixHeader, fontSize: 9 }}>CT</div>
                {doublesPerTeam().map((c, i) => (
                  <div key={i} style={{ ...S.matrixCell, ...S.matrixHeader, color: c === 3 ? "#34d399" : c > 3 ? "#f87171" : c === 0 ? "#475569" : "#94a3b8" }}>
                    {c}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <p style={{ fontSize: 10, color: "#64748b", marginTop: 8 }}>
            <span style={{ color: "#34d399" }}>✕</span> manual{"  "}
            <span style={{ color: "#f87171" }}>H</span> hard avoid (last 2 seasons){"  "}
            <span style={{ color: "#fbbf24" }}>S</span> soft avoid (3rd season)
          </p>

          <div style={{ display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
            <button style={S.secondaryBtn} onClick={() => setManualDoubles(new Set())}>Clear Manual</button>
            <button style={S.primaryBtn} onClick={handleGenerate}>Generate Schedule →</button>
          </div>
          {genError && <p style={S.error}>{genError}</p>}
        </div>
      )}

      {/* ═══ STEP 3: SCHEDULE ═══ */}
      {step === "schedule" && schedule && (
        <div style={S.card}>
          <h2 style={S.cardTitle}>Generated Schedule</h2>

          {schedule.hardRepeated.length > 0 && (
            <div style={S.warn}>
              ⚠ {schedule.hardRepeated.length} hard-avoid pair(s) couldn't be skipped (marked ★). This shouldn't happen with clean history.
            </div>
          )}
          {schedule.softRepeated.length > 0 && (
            <p style={{ fontSize: 11, color: "#94a3b8", margin: "0 0 12px" }}>
              {schedule.softRepeated.length} pair(s) repeated from 3 seasons ago — this is expected (~6 per year to maintain the rotation).
            </p>
          )}

          <div style={S.weekNav}>
            {schedule.weeks.map((_, i) => (
              <button key={i} onClick={() => setSelectedWeek(i)} style={{ ...S.weekBtn, ...(selectedWeek === i ? S.weekBtnActive : {}) }}>
                {i + 1}
              </button>
            ))}
          </div>

          <div style={S.weekCard}>
            <h3 style={S.weekTitle}>Week {selectedWeek + 1}</h3>
            <div style={S.matchups}>
              {schedule.weeks[selectedWeek].map(([a, b], gi) => {
                const isDouble = schedule.doubledPairs.has(pairKey(a, b));
                const isRepeat = schedule.hardRepeated.includes(pairKey(a, b));
                return (
                  <div key={gi} style={S.matchup}>
                    <span style={S.matchupTeam}>{teams[a]}</span>
                    <span style={{ ...S.vs, color: isDouble ? "#34d399" : "#475569" }}>vs</span>
                    <span style={S.matchupTeam}>{teams[b]}</span>
                    {isRepeat && <span style={S.star}>★</span>}
                  </div>
                );
              })}
            </div>
          </div>

          <details style={S.details}>
            <summary style={S.summary}>Double Matchup Summary</summary>
            <div style={S.summaryGrid}>
              {teams.map((t, i) => {
                const partners = [];
                schedule.doubledPairs.forEach((key) => {
                  const [a, b] = key.split("-").map(Number);
                  if (a === i) partners.push(teams[b]);
                  if (b === i) partners.push(teams[a]);
                });
                return (
                  <div key={i} style={S.summaryRow}>
                    <span style={S.summaryTeam}>{t}</span>
                    <span style={S.summaryPartners}>{partners.join(", ")}</span>
                  </div>
                );
              })}
            </div>
          </details>

          <div style={{ display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap" }}>
            <button style={S.secondaryBtn} onClick={handleGenerate}>Re-generate</button>
            {!saved ? (
              <button style={S.primaryBtn} onClick={handleSaveSeason}>Save & Lock Season</button>
            ) : (
              <span style={S.savedBadge}>✓ Saved — this season's doubles feed next year's avoidance</span>
            )}
          </div>

          <details style={{ ...S.details, marginTop: 16 }}>
            <summary style={S.summary}>Copy Full Schedule as Text</summary>
            <textarea
              readOnly
              style={S.exportBox}
              value={schedule.weeks
                .map((week, wi) =>
                  `Week ${wi + 1}\n` + week.map(([a, b]) =>
                    `  ${teams[a]}  vs  ${teams[b]}`
                  ).join("\n")
                ).join("\n\n")}
              rows={12}
              onClick={(e) => e.target.select()}
            />
          </details>
        </div>
      )}

      {step === "schedule" && !schedule && (
        <div style={S.card}><p style={S.hint}>No schedule generated yet. Go to step 2 and click Generate.</p></div>
      )}

      {history.length > 0 && (
        <details style={{ ...S.details, marginTop: 24, maxWidth: 700, margin: "24px auto 0" }}>
          <summary style={S.summary}>Season History ({history.length} saved)</summary>
          {history.map((h, si) => {
            const age = history.length - si;
            return (
              <div key={si} style={S.historyEntry}>
                <strong style={{ color: "#e2e8f0" }}>{h.season}</strong>
                <span style={{ color: "#94a3b8", marginLeft: 8 }}>{(h.doubles || []).length} doubled pairs</span>
                <span style={{ marginLeft: 8, fontSize: 10, color: age <= 2 ? "#f87171" : age === 3 ? "#fbbf24" : "#475569" }}>
                  {age <= 2 ? "HARD AVOID" : age === 3 ? "SOFT AVOID" : "ROTATED OUT"}
                </span>
              </div>
            );
          })}
          {!confirmClear ? (
            <button
              style={{ ...S.secondaryBtn, marginTop: 12, fontSize: 12 }}
              onClick={() => setConfirmClear(true)}
            >Clear History</button>
          ) : (
            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "#f87171" }}>Clear all history?</span>
              <button
                style={{ ...S.primaryBtn, background: "#dc2626", padding: "4px 10px", fontSize: 11 }}
                onClick={async () => {
                  setHistory([]);
                  setManualDoubles(new Set());
                  setSaved(false);
                  setConfirmClear(false);
                  await saveToStorage({ history: [], manualDoubles: [] });
                }}
              >Yes</button>
              <button
                style={{ ...S.secondaryBtn, padding: "4px 10px", fontSize: 11 }}
                onClick={() => setConfirmClear(false)}
              >Cancel</button>
            </div>
          )}
        </details>
      )}

      {/* Full reset */}
      <div style={{ maxWidth: 700, margin: "24px auto 0", textAlign: "center" }}>
        {!confirmReset ? (
          <button
            style={{ ...S.secondaryBtn, fontSize: 11, color: "#64748b", borderColor: "#334155" }}
            onClick={() => setConfirmReset(true)}
          >Reset Everything</button>
        ) : (
          <div style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#f87171" }}>Clear all data? Cannot be undone.</span>
            <button
              style={{ ...S.primaryBtn, background: "#dc2626", padding: "6px 14px", fontSize: 11 }}
              onClick={async () => {
                setTeams(Array(N).fill("").map((_, i) => `Team ${i + 1}`));
                setUserIds(Array(N).fill(null));
                setHistory([]);
                setManualDoubles(new Set());
                setSchedule(null);
                setSaved(false);
                resetSleeper();
                setPasteText("");
                setParseResult(null);
                setStep("teams");
                setConfirmReset(false);
                try { await window.storage.delete(STORAGE_KEY); } catch (e) {}
              }}
            >Yes, reset</button>
            <button
              style={{ ...S.secondaryBtn, padding: "6px 14px", fontSize: 11 }}
              onClick={() => setConfirmReset(false)}
            >Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────

const S = {
  container: { fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace", background: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)", minHeight: "100vh", padding: "24px 16px", color: "#e2e8f0" },
  header: { textAlign: "center", marginBottom: 28 },
  title: { fontSize: 22, fontWeight: 800, color: "#f0fdf4", margin: 0, letterSpacing: "-0.5px", textTransform: "uppercase" },
  subtitle: { fontSize: 11, color: "#64748b", marginTop: 4, letterSpacing: "1px" },
  nav: { display: "flex", justifyContent: "center", gap: 4, marginBottom: 20, flexWrap: "wrap" },
  navBtn: { background: "transparent", border: "1px solid #334155", color: "#94a3b8", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit" },
  navBtnActive: { background: "#065f46", borderColor: "#059669", color: "#ecfdf5" },
  card: { background: "#1e293b", border: "1px solid #334155", borderRadius: 10, padding: 20, maxWidth: 700, margin: "0 auto" },
  cardTitle: { fontSize: 16, fontWeight: 700, color: "#f0fdf4", margin: "0 0 6px 0" },
  hint: { fontSize: 12, color: "#94a3b8", lineHeight: 1.5, margin: "0 0 12px 0" },
  teamGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 },
  teamInputWrap: { display: "flex", alignItems: "center", gap: 8, background: "#0f172a", borderRadius: 6, padding: "4px 8px", border: "1px solid #334155" },
  teamNum: { fontSize: 11, color: "#475569", minWidth: 16, textAlign: "right" },
  teamInput: { flex: 1, background: "transparent", border: "none", outline: "none", color: "#e2e8f0", fontSize: 13, fontFamily: "inherit", padding: "4px 0" },
  primaryBtn: { background: "linear-gradient(135deg, #059669, #047857)", color: "#ecfdf5", border: "none", padding: "10px 22px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" },
  secondaryBtn: { background: "transparent", color: "#94a3b8", border: "1px solid #475569", padding: "10px 18px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontFamily: "inherit" },
  lookbackBox: { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", marginBottom: 16 },
  pasteSection: { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: 14, marginBottom: 12 },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: "#e2e8f0", margin: "0 0 6px 0" },
  pasteBox: { width: "100%", background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: 10, fontSize: 11, fontFamily: "inherit", resize: "vertical", marginBottom: 8, boxSizing: "border-box" },
  parseResults: { marginTop: 10, padding: "10px 12px", background: "#1e293b", borderRadius: 6, border: "1px solid #334155" },
  mapRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 6, padding: "4px 0" },
  mapSelect: { background: "#0f172a", color: "#e2e8f0", border: "1px solid #475569", borderRadius: 4, padding: "3px 6px", fontSize: 12, fontFamily: "inherit" },
  divider: { display: "flex", alignItems: "center", margin: "16px 0", gap: 12 },
  dividerText: { fontSize: 11, color: "#475569", textTransform: "uppercase", letterSpacing: "1.5px", whiteSpace: "nowrap", width: "100%", textAlign: "center", borderTop: "1px solid #334155", paddingTop: 12 },
  matrixWrap: { overflowX: "auto", margin: "0 -8px", padding: "0 8px" },
  matrix: { display: "inline-block", minWidth: "fit-content" },
  matrixRow: { display: "flex" },
  matrixCell: { width: 42, minWidth: 42, height: 28, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, border: "1px solid #1e293b", boxSizing: "border-box" },
  matrixHeader: { background: "#0f172a", color: "#64748b", fontWeight: 600, fontSize: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  matrixEmpty: { background: "#0f172a" },
  matrixClickable: { background: "#1e293b", cursor: "pointer", transition: "background 0.1s", color: "#64748b", userSelect: "none" },
  matrixManual: { background: "#065f46", color: "#34d399", fontWeight: 700, fontSize: 12 },
  matrixHard: { background: "#450a0a", color: "#f87171", fontWeight: 700, fontSize: 10 },
  matrixSoft: { background: "#451a03", color: "#fbbf24", fontWeight: 600, fontSize: 10 },
  error: { color: "#f87171", fontSize: 12, marginTop: 12 },
  warn: { background: "#451a03", border: "1px solid #92400e", borderRadius: 6, padding: "8px 12px", fontSize: 11, color: "#fbbf24", marginBottom: 12 },
  weekNav: { display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 16 },
  weekBtn: { width: 34, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "#0f172a", border: "1px solid #334155", borderRadius: 4, color: "#94a3b8", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
  weekBtnActive: { background: "#065f46", borderColor: "#059669", color: "#ecfdf5" },
  weekCard: { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: 16 },
  weekTitle: { fontSize: 14, fontWeight: 700, color: "#f0fdf4", margin: "0 0 12px 0" },
  matchups: { display: "flex", flexDirection: "column", gap: 8 },
  matchup: { display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "#1e293b", borderRadius: 6, border: "1px solid #334155" },
  matchupTeam: { flex: 1, fontSize: 13, color: "#e2e8f0", textAlign: "center" },
  vs: { fontSize: 11, fontWeight: 700 },
  star: { color: "#fbbf24", fontSize: 14, marginLeft: 4 },
  details: { marginTop: 8 },
  summary: { cursor: "pointer", fontSize: 12, color: "#94a3b8", padding: "6px 0", userSelect: "none" },
  summaryGrid: { display: "flex", flexDirection: "column", gap: 4, marginTop: 8 },
  summaryRow: { display: "flex", gap: 12, fontSize: 12, padding: "4px 8px", background: "#0f172a", borderRadius: 4 },
  summaryTeam: { color: "#e2e8f0", fontWeight: 600, minWidth: 100 },
  summaryPartners: { color: "#34d399" },
  savedBadge: { color: "#34d399", fontSize: 13, fontWeight: 600, alignSelf: "center" },
  exportBox: { width: "100%", background: "#0f172a", color: "#94a3b8", border: "1px solid #334155", borderRadius: 6, padding: 10, fontSize: 11, fontFamily: "inherit", resize: "vertical", marginTop: 8, boxSizing: "border-box" },
  historyEntry: { padding: "6px 8px", borderBottom: "1px solid #334155", fontSize: 12 },
};
