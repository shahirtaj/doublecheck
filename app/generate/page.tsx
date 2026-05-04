"use client";

import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from "react";
import {
  buildAvoidMap,
  buildSchedule,
  describeFormat,
  pairKey,
  unpackPairKey,
  type Matching,
  type PairKey,
  type SeasonHistory,
  type ScheduleSuccess,
} from "@/lib/algorithm";

// ── Format constants ──────────────────────────────────────
// The prototype runs the 12-team / 14-week format. Phase 2 ports the prototype
// as-is; Phase 3+ will surface the format picker for other supported sizes.
const TEAM_COUNT = 12;
const WEEK_COUNT = 14;
const STORAGE_KEY = "ff-rotational-scheduler";
const FORMAT = describeFormat(TEAM_COUNT, WEEK_COUNT);

// ── Types ─────────────────────────────────────────────────

type SleeperSeasonInfo = {
  leagueId: string;
  name: string;
  season: string;
  hasData: boolean;
  settings?: { playoff_week_start?: number };
  previousLeagueId?: string | null;
};

type SleeperSeasonData = {
  teamNames: string[];
  userIds: (string | null)[];
  doubles: Set<PairKey>;
  totalMatchups: number;
  regWeeks: number;
};

type SleeperImportPayload = SleeperSeasonData & {
  seasonName?: string;
  seasonYear?: string;
  // For multi-season JSON imports: each entry has its own teamNames/userIds/doubles.
  allSeasons?: ImportedSeasonRecord[];
};

type ImportedSeasonRecord = {
  seasonYear?: string;
  seasonName?: string;
  teamNames: string[];
  userIds: (string | null)[];
  doubles: PairKey[];
  regWeeks?: number;
};

type ParseResult =
  | {
      success: true;
      rawPairs: [string, string][];
      uniqueNames: string[];
      nameToIndex: Record<string, number>;
      unmapped: string[];
    }
  | { success: false; error: string };

type Step = "teams" | "doubles" | "schedule";

type SleeperStatus =
  | ""
  | "loading"
  | "discovered"
  | "importing"
  | "imported"
  | "backfilled"
  | "error";

// ── Schedule paste parser ─────────────────────────────────

function parseScheduleText(text: string, teamNames: string[]): ParseResult {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const rawPairs: [string, string][] = [];
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
        a = a
          .replace(/\s+\d+(\.\d+)?$/, "")
          .replace(/\s*\(.*?\)\s*$/, "")
          .trim();
        b = b
          .replace(/^\d+(\.\d+)?\s+/, "")
          .replace(/\s+\d+(\.\d+)?$/, "")
          .replace(/\s*\(.*?\)\s*$/, "")
          .trim();
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
        rawPairs.push([
          parts[0]!.replace(/\s+\d+(\.\d+)?$/, "").trim(),
          parts[1]!.replace(/\s+\d+(\.\d+)?$/, "").trim(),
        ]);
      }
    }
  }

  if (rawPairs.length === 0) {
    return {
      success: false,
      error: "No matchups found. Use a format like 'Team A vs Team B', one per line.",
    };
  }

  const uniqueNames = [...new Set(rawPairs.flat())];
  const nameToIndex: Record<string, number> = {};
  const unmapped: string[] = [];

  for (const name of uniqueNames) {
    let idx = teamNames.findIndex((t) => t.toLowerCase() === name.toLowerCase());
    if (idx === -1) {
      idx = teamNames.findIndex(
        (t) =>
          t.length >= 3 &&
          (name.toLowerCase().includes(t.toLowerCase()) ||
            t.toLowerCase().includes(name.toLowerCase())),
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

function detectDoublesFromPairs(indexedPairs: [number, number][]): Set<PairKey> {
  const counts: Record<PairKey, number> = {};
  indexedPairs.forEach(([a, b]) => {
    const k = pairKey(a, b);
    counts[k] = (counts[k] || 0) + 1;
  });
  return new Set(
    Object.entries(counts)
      .filter(([, v]) => v > 1)
      .map(([k]) => k),
  );
}

// ── Sleeper live fetch (subject to CORS in browser) ───────

async function discoverSleeperChain(
  leagueId: string,
  onStatus: (msg: string) => void,
): Promise<SleeperSeasonInfo[]> {
  const base = "https://api.sleeper.app/v1";
  const seasons: SleeperSeasonInfo[] = [];
  let currentId = leagueId;

  for (let depth = 0; depth < 5; depth++) {
    onStatus(`Discovering seasons… (${seasons.length} found)`);
    const res = await fetch(`${base}/league/${currentId}`);
    if (!res.ok) break;
    const league = await res.json();
    if (!league?.league_id) break;

    const week1 = await fetch(`${base}/league/${currentId}/matchups/1`).then((r) => r.json());
    const hasData =
      Array.isArray(week1) && week1.some((m: any) => m.matchup_id != null && m.points > 0);

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

async function fetchSleeperSeason(
  leagueId: string,
  settings: SleeperSeasonInfo["settings"],
  onStatus: (msg: string) => void,
): Promise<SleeperSeasonData> {
  const base = "https://api.sleeper.app/v1";
  onStatus("Fetching managers…");

  const users = await fetch(`${base}/league/${leagueId}/users`).then((r) => r.json());
  const rosters = await fetch(`${base}/league/${leagueId}/rosters`).then((r) => r.json());

  if (!Array.isArray(rosters) || rosters.length !== TEAM_COUNT) {
    throw new Error(`Expected ${TEAM_COUNT} teams but found ${rosters?.length || 0}.`);
  }

  const ownerInfo: Record<string, string> = {};
  (users || []).forEach((u: any) => {
    ownerInfo[u.user_id] = u.display_name || u.metadata?.team_name || u.user_id;
  });

  const sorted = [...rosters].sort((a: any, b: any) => a.roster_id - b.roster_id);
  const rosterIdToIdx: Record<number, number> = {};
  const teamNames: string[] = [];
  const userIds: (string | null)[] = [];
  sorted.forEach((r: any, idx: number) => {
    rosterIdToIdx[r.roster_id] = idx;
    teamNames.push(ownerInfo[r.owner_id] || `Roster ${r.roster_id}`);
    userIds.push(r.owner_id || null);
  });

  const regWeeks = settings?.playoff_week_start ? settings.playoff_week_start - 1 : WEEK_COUNT;
  onStatus(`Fetching ${regWeeks} weeks of matchups…`);

  const allPairs: [number, number][] = [];
  for (let week = 1; week <= regWeeks; week++) {
    const matchups = await fetch(`${base}/league/${leagueId}/matchups/${week}`).then((r) =>
      r.json(),
    );
    if (!Array.isArray(matchups)) continue;
    const groups: Record<number, number[]> = {};
    matchups.forEach((m: any) => {
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

  const doubles = detectDoublesFromPairs(allPairs);
  return { teamNames, userIds, doubles, totalMatchups: allPairs.length, regWeeks };
}

// ── Component ─────────────────────────────────────────────

export default function GeneratePage() {
  const [step, setStep] = useState<Step>("teams");
  const [teams, setTeams] = useState<string[]>(() =>
    Array(TEAM_COUNT).fill("").map((_, i) => `Team ${i + 1}`),
  );
  const [userIds, setUserIds] = useState<(string | null)[]>(() =>
    Array(TEAM_COUNT).fill(null),
  );
  const [manualDoubles, setManualDoubles] = useState<Set<PairKey>>(() => new Set());
  const [schedule, setSchedule] = useState<ScheduleSuccess | null>(null);
  const [history, setHistory] = useState<SeasonHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [genError, setGenError] = useState("");
  const [selectedWeek, setSelectedWeek] = useState(0);
  const [saved, setSaved] = useState(false);

  const [pasteText, setPasteText] = useState("");
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [nameMapping, setNameMapping] = useState<Record<string, number | undefined>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const [sleeperId, setSleeperId] = useState("");
  const [sleeperJson, setSleeperJson] = useState("");
  const [sleeperStatus, setSleeperStatus] = useState<SleeperStatus>("");
  const [sleeperMsg, setSleeperMsg] = useState("");
  const [sleeperSeasons, setSleeperSeasons] = useState<SleeperSeasonInfo[]>([]);
  const [sleeperData, setSleeperData] = useState<SleeperImportPayload | null>(null);

  // Hydrate from localStorage on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (Array.isArray(d.teams) && d.teams.length === TEAM_COUNT) setTeams(d.teams);
        if (Array.isArray(d.userIds) && d.userIds.length === TEAM_COUNT) setUserIds(d.userIds);
        if (Array.isArray(d.history)) setHistory(d.history);
        if (Array.isArray(d.manualDoubles)) setManualDoubles(new Set(d.manualDoubles));
      }
    } catch {
      // Ignore corrupt storage; fall back to defaults.
    }
    setLoading(false);
  }, []);

  const saveToStorage = useCallback(
    (extra: Partial<{ teams: string[]; userIds: (string | null)[]; history: SeasonHistory[]; manualDoubles: PairKey[] }> = {}) => {
      try {
        const payload = {
          teams,
          userIds,
          history,
          manualDoubles: [...manualDoubles],
          ...extra,
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // Storage may be full or unavailable; ignore.
      }
    },
    [teams, userIds, history, manualDoubles],
  );

  function getAvoidSets() {
    const { hard, soft } = buildAvoidMap(history, userIds, FORMAT.lookback);
    manualDoubles.forEach((key) => {
      hard.add(key);
      soft.delete(key);
    });
    return { hard, soft };
  }

  function getAvoidDisplay() {
    const { hard, soft } = getAvoidSets();
    return { hard: hard.size, soft: soft.size, total: hard.size + soft.size };
  }

  function handleGenerate() {
    setGenError("");
    setSaved(false);
    const { hard, soft } = getAvoidSets();
    const result = buildSchedule({
      teamCount: TEAM_COUNT,
      weekCount: WEEK_COUNT,
      hardAvoid: hard,
      softAvoid: soft,
    });
    if (!result.ok) {
      setGenError(
        result.reason === "generation-failed"
          ? "Could not generate a valid schedule. Try clearing some avoid-pairs."
          : result.message,
      );
      return;
    }
    setSchedule(result);
    setSelectedWeek(0);
    setStep("schedule");
  }

  function handleSaveSeason() {
    if (!schedule) return;
    const currentYear = new Date().getFullYear();
    const lastYearStr = history.length > 0 ? history[history.length - 1]!.season : "";
    const lastYear = parseInt(lastYearStr, 10);
    const seasonLabel = String(
      Math.max(currentYear, Number.isNaN(lastYear) ? currentYear : lastYear + 1),
    );
    const hasUserIds = userIds.some((id) => id != null);

    let doubles: PairKey[];
    let format: "userid" | "index";
    if (hasUserIds) {
      doubles = [...schedule.doubledPairs].map((key) => {
        const [a, b] = unpackPairKey(key);
        return [userIds[a], userIds[b]].sort().join(":");
      });
      format = "userid";
    } else {
      doubles = [...schedule.doubledPairs];
      format = "index";
    }

    const entry: SeasonHistory = { season: seasonLabel, doubles, format };
    const newHistory = [...history, entry];
    setHistory(newHistory);
    setManualDoubles(new Set());
    saveToStorage({ history: newHistory, manualDoubles: [] });
    setSaved(true);
  }

  function toggleDouble(i: number, j: number) {
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
    if (!parseResult || !parseResult.success) return;
    const indexedPairs: [number, number][] = [];
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
    if (!parseResult || !parseResult.success) return false;
    return parseResult.uniqueNames.every((name) => nameMapping[name] !== undefined);
  }

  // ── Sleeper handlers ──

  function resetSleeper() {
    setSleeperStatus("");
    setSleeperMsg("");
    setSleeperData(null);
    setSleeperSeasons([]);
  }

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
      setSleeperMsg(
        `Found ${withData.length} completed season${withData.length > 1 ? "s" : ""} in league history.`,
      );
    } catch (e) {
      setSleeperStatus("error");
      const msg = (e as Error).message || "Unknown error";
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("CORS")) {
        setSleeperMsg(
          "Network error — Sleeper's API may block browser requests. Use the paste method below instead.",
        );
      } else {
        setSleeperMsg(msg);
      }
    }
  }

  async function handleSleeperImportSeason(seasonInfo: SleeperSeasonInfo) {
    setSleeperStatus("importing");
    setSleeperMsg(`Importing ${seasonInfo.season} season…`);
    try {
      const data = await fetchSleeperSeason(seasonInfo.leagueId, seasonInfo.settings, setSleeperMsg);
      setSleeperData({
        ...data,
        seasonName: seasonInfo.name,
        seasonYear: seasonInfo.season,
      });
      setSleeperStatus("imported");
      setSleeperMsg(
        `Imported ${seasonInfo.season}: ${data.totalMatchups} matchups, ${data.doubles.size} doubled pairs.`,
      );
    } catch (e) {
      setSleeperStatus("error");
      setSleeperMsg((e as Error).message || "Import failed.");
    }
  }

  async function handleSleeperBackfill() {
    const withData = sleeperSeasons.filter((s) => s.hasData);
    const toImport = withData.slice(0, 3).reverse();
    setSleeperStatus("importing");

    const mostRecent = withData[0];
    let latestData: SleeperSeasonData | null = null;
    const collected: SeasonHistory[] = [];

    for (let i = 0; i < toImport.length; i++) {
      const s = toImport[i]!;
      setSleeperMsg(`Importing ${s.season} season… (${i + 1}/${toImport.length})`);
      try {
        const data = await fetchSleeperSeason(s.leagueId, s.settings, setSleeperMsg);
        const doubles = [...data.doubles].map((key) => {
          const [a, b] = unpackPairKey(key);
          return [data.userIds[a], data.userIds[b]].sort().join(":");
        });
        collected.push({ season: s.season, doubles, format: "userid" });
        if (s === mostRecent) latestData = data;
      } catch (e) {
        setSleeperMsg(`Failed on ${s.season}: ${(e as Error).message}. Earlier seasons were saved.`);
        setSleeperStatus("error");
        if (collected.length) {
          const merged = [...history, ...collected];
          setHistory(merged);
          saveToStorage({ history: merged, manualDoubles: [] });
        }
        return;
      }
    }

    const newHistory = [...history, ...collected];
    setHistory(newHistory);
    if (latestData) {
      setTeams(latestData.teamNames);
      setUserIds(latestData.userIds);
    }
    saveToStorage({
      history: newHistory,
      manualDoubles: [],
      ...(latestData ? { teams: latestData.teamNames, userIds: latestData.userIds } : {}),
    });

    setSleeperStatus("backfilled");
    setSleeperMsg(`Backfilled ${toImport.length} seasons into history. Ready to generate.`);
  }

  function handleSleeperApply() {
    if (!sleeperData) return;
    const hasCustomNames = teams.some((t, i) => t !== `Team ${i + 1}`);
    let nextTeams = teams;
    if (!hasCustomNames) {
      nextTeams = sleeperData.teamNames;
      setTeams(nextTeams);
    }
    const nextUserIds = sleeperData.userIds;
    setUserIds(nextUserIds);

    // Multi-season JSON import passes allSeasons (most recent first → reverse to oldest first).
    const seasonsToImport: ImportedSeasonRecord[] = sleeperData.allSeasons
      ? [...sleeperData.allSeasons].reverse()
      : [
          {
            seasonYear: sleeperData.seasonYear,
            teamNames: sleeperData.teamNames,
            userIds: sleeperData.userIds,
            doubles: [...sleeperData.doubles],
            regWeeks: sleeperData.regWeeks,
          },
        ];

    const newHistory = [...history];
    for (const season of seasonsToImport) {
      const sUserIds = season.userIds;
      const hasUids = sUserIds.some((id) => id != null);
      const sDoubles = season.doubles;
      let importDoubles: PairKey[];
      if (hasUids) {
        importDoubles = sDoubles.map((key) => {
          const [a, b] = unpackPairKey(key);
          return [sUserIds[a], sUserIds[b]].sort().join(":");
        });
      } else {
        importDoubles = sDoubles;
      }

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
    saveToStorage({ history: newHistory, teams: nextTeams, userIds: nextUserIds });

    setManualDoubles(new Set());
    setSleeperStatus("");
    setSleeperMsg("");
    setSleeperData(null);
    setSleeperSeasons([]);
    setSleeperId("");
  }

  function handleJsonImport() {
    try {
      const raw = JSON.parse(sleeperJson);
      const seasons: ImportedSeasonRecord[] = Array.isArray(raw) ? raw : [raw];
      if (seasons.length === 0) throw new Error("No season data found.");
      for (const s of seasons) {
        if (!s.teamNames || !s.userIds || !s.doubles) {
          throw new Error("Missing required fields (teamNames, userIds, doubles).");
        }
        if (s.teamNames.length !== TEAM_COUNT) {
          throw new Error(`Expected ${TEAM_COUNT} teams but found ${s.teamNames.length}.`);
        }
      }

      const primary = seasons[0]!;
      const doublesSet = new Set<PairKey>(primary.doubles);
      setSleeperData({
        teamNames: primary.teamNames,
        userIds: primary.userIds,
        doubles: doublesSet,
        regWeeks: primary.regWeeks || WEEK_COUNT,
        totalMatchups: 0,
        seasonYear: primary.seasonYear || "",
        allSeasons: seasons,
      });
      setSleeperStatus("imported");
      const label =
        seasons.length > 1
          ? `Imported ${seasons.length} seasons from JSON (${seasons.map((s) => s.seasonYear).join(", ")}).`
          : `Imported from JSON: ${primary.doubles.length} doubled pairs (${primary.seasonYear || "unknown season"}).`;
      setSleeperMsg(label);
      setSleeperJson("");
    } catch (e) {
      setSleeperStatus("error");
      setSleeperMsg(`JSON parse error: ${(e as Error).message}`);
    }
  }

  // ── Derived helpers ──

  function doublesPerTeam() {
    const counts = Array(TEAM_COUNT).fill(0);
    manualDoubles.forEach((key) => {
      const [a, b] = unpackPairKey(key);
      counts[a]++;
      counts[b]++;
    });
    return counts;
  }

  function abbrev(name: string) {
    return name.length > 5 ? name.slice(0, 5) : name;
  }

  function cellAvoidType(i: number, j: number): "manual" | "hard" | "soft" | "none" {
    const key = pairKey(i, j);
    if (manualDoubles.has(key)) return "manual";
    const { hard, soft } = buildAvoidMap(history, userIds, FORMAT.lookback);
    if (hard.has(key)) return "hard";
    if (soft.has(key)) return "soft";
    return "none";
  }

  function handleResetEverything() {
    setTeams(Array(TEAM_COUNT).fill("").map((_, i) => `Team ${i + 1}`));
    setUserIds(Array(TEAM_COUNT).fill(null));
    setHistory([]);
    setManualDoubles(new Set());
    setSchedule(null);
    setSaved(false);
    resetSleeper();
    setPasteText("");
    setParseResult(null);
    setStep("teams");
    setConfirmReset(false);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen px-4 py-6">
        <p className="mt-20 text-center text-slate-400">Loading…</p>
      </div>
    );
  }

  const avoidInfo = getAvoidDisplay();

  // ── Tailwind class atoms (mirrors the prototype's S object) ──

  const cls = {
    primaryBtn:
      "bg-gradient-to-br from-emerald-600 to-emerald-700 text-emerald-50 border-0 px-5 py-2.5 rounded-md text-[13px] font-semibold cursor-pointer hover:from-emerald-500 hover:to-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed",
    secondaryBtn:
      "bg-transparent text-slate-400 border border-slate-600 px-4 py-2.5 rounded-md text-[13px] cursor-pointer hover:border-slate-500 hover:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed",
    card: "bg-slate-800 border border-slate-700 rounded-xl p-5 max-w-[700px] mx-auto",
    cardTitle: "text-base font-bold text-emerald-50 mb-1.5",
    hint: "text-xs text-slate-400 leading-relaxed mb-3",
    pasteSection: "bg-slate-900 border border-slate-700 rounded-lg p-3.5 mb-3",
    sectionTitle: "text-[13px] font-bold text-slate-200 mb-1.5",
    pasteBox:
      "w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-md p-2.5 text-[11px] font-mono resize-y mb-2 box-border outline-none focus:border-slate-500",
    teamInput:
      "flex-1 bg-transparent border-0 outline-none text-slate-200 text-[13px] font-mono py-1",
    error: "text-red-400 text-xs mt-3",
  };

  return (
    <div className="min-h-screen px-4 py-6 text-slate-200 font-mono">
      <div className="text-center mb-7">
        <h1 className="text-xl sm:text-2xl font-extrabold text-emerald-50 uppercase tracking-tight">
          DoubleCheck
        </h1>
        <p className="text-[11px] text-slate-500 mt-1 tracking-wider">
          {WEEK_COUNT}-week rotational scheduling · {TEAM_COUNT}-team leagues
        </p>
      </div>

      <div className="flex justify-center gap-1 mb-5 flex-wrap">
        {(
          [
            ["teams", "1 · Import"],
            ["doubles", "2 · Review"],
            ["schedule", "3 · Schedule"],
          ] as [Step, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setStep(key)}
            className={`bg-transparent border px-3.5 py-1.5 rounded-md text-xs font-mono cursor-pointer ${
              step === key
                ? "bg-emerald-800 border-emerald-600 text-emerald-50"
                : "border-slate-700 text-slate-400 hover:border-slate-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ═══ STEP 1: IMPORT ═══ */}
      {step === "teams" && (
        <div className={cls.card}>
          <h2 className={cls.cardTitle}>Import Last Season</h2>

          {/* Sleeper live fetch */}
          <div className={cls.pasteSection}>
            <h3 className={cls.sectionTitle}>Import from Sleeper</h3>
            <p className={cls.hint}>
              Enter your current Sleeper league ID — the tool walks the history chain to find
              completed seasons. Find it in your league URL: sleeper.com/leagues/
              <strong>YOUR_ID</strong>
            </p>
            <div className="flex flex-wrap gap-2 items-stretch">
              <input
                className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 font-mono outline-none focus:border-slate-500"
                value={sleeperId}
                onChange={(e) => {
                  setSleeperId(e.target.value);
                  resetSleeper();
                }}
                placeholder="e.g. 924039458279227392"
              />
              <button
                className={cls.primaryBtn}
                onClick={handleSleeperFetch}
                disabled={
                  !sleeperId.trim() ||
                  sleeperStatus === "loading" ||
                  sleeperStatus === "importing"
                }
              >
                {sleeperStatus === "loading" ? "Searching…" : "Fetch"}
              </button>
            </div>

            {sleeperMsg && (
              <p
                className={`text-[11px] mt-2 ${
                  sleeperStatus === "error"
                    ? "text-red-400"
                    : sleeperStatus === "backfilled" || sleeperStatus === "imported"
                      ? "text-emerald-400"
                      : "text-slate-400"
                }`}
              >
                {sleeperMsg}
              </p>
            )}

            {/* Discovered seasons */}
            {sleeperStatus === "discovered" && sleeperSeasons.length > 0 && (
              <div className="mt-2.5 px-3 py-2.5 bg-slate-800 rounded-md border border-slate-700">
                <p className="text-xs text-slate-200 mb-2">Seasons found:</p>
                {sleeperSeasons.map((s, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-2.5 py-1 ${
                      i < sleeperSeasons.length - 1 ? "border-b border-slate-700" : ""
                    }`}
                  >
                    <span
                      className={`text-xs flex-1 ${s.hasData ? "text-slate-200" : "text-slate-600"}`}
                    >
                      {s.season} — {s.name}
                      {!s.hasData && (
                        <span className="text-slate-600 ml-1.5">(no data)</span>
                      )}
                    </span>
                    {s.hasData && (
                      <button
                        className="bg-transparent text-slate-400 border border-slate-600 rounded-md px-2.5 py-1 text-[11px] hover:border-slate-500 hover:text-slate-300"
                        onClick={() => handleSleeperImportSeason(s)}
                      >
                        Import
                      </button>
                    )}
                  </div>
                ))}
                {sleeperSeasons.filter((s) => s.hasData).length >= 2 && (
                  <div className="mt-2.5">
                    <button className={cls.primaryBtn} onClick={handleSleeperBackfill}>
                      Backfill All ({sleeperSeasons.filter((s) => s.hasData).length} seasons →
                      history)
                    </button>
                    <p className="text-[10px] text-slate-500 mt-1.5">
                      Imports all completed seasons into history at once. Sets manager names from
                      the most recent season.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Single import preview */}
            {sleeperData && sleeperStatus === "imported" && (
              <div className="mt-2.5 px-3 py-2.5 bg-slate-800 rounded-md border border-slate-700">
                <p className="text-xs text-slate-200 mb-1">
                  Managers: {sleeperData.teamNames.join(", ")}
                </p>
                <p className="text-xs text-emerald-400 mb-2.5">
                  {sleeperData.doubles.size} doubled pairs detected across{" "}
                  {sleeperData.regWeeks} weeks ({sleeperData.seasonYear}).
                </p>
                <div className="flex gap-2 flex-wrap items-center">
                  <button className={cls.primaryBtn} onClick={handleSleeperApply}>
                    Apply
                  </button>
                  <span className="text-[10px] text-slate-500">
                    {teams.some((t, i) => t !== `Team ${i + 1}`)
                      ? "Keeps your custom names"
                      : "Imports Sleeper usernames"}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* JSON paste fallback */}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
              Paste Sleeper JSON (if live fetch is blocked)
            </summary>
            <div className={`${cls.pasteSection} mt-2`}>
              <p className={cls.hint}>
                Run{" "}
                <code className="text-slate-200 bg-slate-900 px-1.5 py-px rounded">
                  node fetch-sleeper.js YOUR_LEAGUE_ID
                </code>{" "}
                and paste the output here.
              </p>
              <textarea
                className={cls.pasteBox}
                value={sleeperJson}
                onChange={(e) => setSleeperJson(e.target.value)}
                placeholder="Paste JSON output from fetch-sleeper.js..."
                rows={4}
              />
              <button
                className={cls.secondaryBtn}
                onClick={handleJsonImport}
                disabled={!sleeperJson.trim()}
              >
                Import JSON
              </button>
            </div>
          </details>

          <div className="flex items-center my-4 gap-3">
            <span className="text-[11px] text-slate-600 uppercase tracking-widest whitespace-nowrap w-full text-center border-t border-slate-700 pt-3">
              manager names
            </span>
          </div>

          <p className={cls.hint}>
            Auto-filled by Sleeper import, or enter manually. Overwrite with real names if you
            prefer those over usernames.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {teams.map((t, i) => (
              <div
                key={i}
                className="flex items-center gap-2 bg-slate-900 rounded-md px-2 py-1 border border-slate-700"
              >
                <span className="text-[11px] text-slate-600 min-w-[1rem] text-right">
                  {i + 1}
                </span>
                <input
                  className={cls.teamInput}
                  value={t}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const next = [...teams];
                    next[i] = e.target.value;
                    setTeams(next);
                  }}
                  placeholder={`Team ${i + 1}`}
                  maxLength={24}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-3 mt-6 flex-wrap">
            <button
              className={cls.primaryBtn}
              onClick={() => {
                saveToStorage();
                setStep("doubles");
              }}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* ═══ STEP 2: AVOID ═══ */}
      {step === "doubles" && (
        <div className={cls.card}>
          <h2 className={cls.cardTitle}>Review Avoidance</h2>

          {history.length > 0 && (
            <div className="bg-slate-900 border border-slate-700 rounded-lg px-3.5 py-2.5 mb-4">
              <strong className="text-slate-200">Lookback Active</strong>
              <p className="mt-1 text-[11px] text-slate-400">
                {history.length} season{history.length > 1 ? "s" : ""} in history.{" "}
                <span className="text-red-400">■</span> Last {FORMAT.lookback.hard} season
                {FORMAT.lookback.hard > 1 ? "s" : ""} = hard avoid{" "}
                {history.length > FORMAT.lookback.hard && FORMAT.lookback.soft > 0 && (
                  <>
                    <span className="text-amber-400">■</span> Older = soft avoid
                  </>
                )}
                {" · "}Older seasons rotate out.
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                {avoidInfo.hard} hard · {avoidInfo.soft} soft · {avoidInfo.total} total
              </p>
            </div>
          )}

          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
              Paste schedule text (non-Sleeper leagues)
            </summary>
            <div className={`${cls.pasteSection} mt-2`}>
              <p className={cls.hint}>
                Paste from ESPN, Yahoo, etc. — &ldquo;Team A vs Team B&rdquo; per line. Scores and
                week headers are stripped automatically.
              </p>
              <textarea
                className={cls.pasteBox}
                value={pasteText}
                onChange={(e) => {
                  setPasteText(e.target.value);
                  setParseResult(null);
                }}
                placeholder={
                  "Week 1\nTeam Alpha vs Team Beta\nTeam Gamma vs Team Delta\n...\n\nWeek 2\nTeam Alpha vs Team Gamma\n..."
                }
                rows={6}
              />
              <button
                className={cls.secondaryBtn}
                onClick={handleParse}
                disabled={!pasteText.trim()}
              >
                Parse Schedule
              </button>

              {parseResult && !parseResult.success && (
                <p className={cls.error}>{parseResult.error}</p>
              )}

              {parseResult && parseResult.success && (
                <div className="mt-2.5 px-3 py-2.5 bg-slate-800 rounded-md border border-slate-700">
                  <p className="text-xs text-slate-200">
                    Found <strong>{parseResult.rawPairs.length}</strong> matchups across{" "}
                    <strong>{parseResult.uniqueNames.length}</strong> teams.
                  </p>

                  {parseResult.unmapped.length > 0 && (
                    <div className="mt-2">
                      <p className="text-[11px] text-amber-400 mb-1.5">
                        {parseResult.unmapped.length} name(s) couldn&apos;t auto-match. Map them
                        below:
                      </p>
                      {parseResult.unmapped.map((name) => (
                        <div key={name} className="flex flex-wrap items-center gap-2 mb-1.5 py-1">
                          <span className="text-slate-200 text-xs min-w-[7.5rem]">
                            &ldquo;{name}&rdquo;
                          </span>
                          <span className="text-slate-600 text-xs">→</span>
                          <select
                            className="bg-slate-900 text-slate-200 border border-slate-600 rounded px-1.5 py-0.5 text-xs font-mono"
                            value={nameMapping[name] ?? ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              setNameMapping((prev) => ({
                                ...prev,
                                [name]: val === "" ? undefined : parseInt(val, 10),
                              }));
                            }}
                          >
                            <option value="">— select —</option>
                            {teams.map((t, idx) => {
                              const taken = Object.entries(nameMapping).some(
                                ([k, v]) => v === idx && k !== name,
                              );
                              return (
                                <option key={idx} value={idx} disabled={taken}>
                                  {t}
                                  {taken ? " (taken)" : ""}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}

                  {allParsedNamesMapped() && (
                    <div className="mt-2.5">
                      {(() => {
                        const indexedPairs: [number, number][] = [];
                        for (const [a, b] of parseResult.rawPairs) {
                          const ai = nameMapping[a];
                          const bi = nameMapping[b];
                          if (ai !== undefined && bi !== undefined && ai !== bi)
                            indexedPairs.push([ai, bi]);
                        }
                        const doubles = detectDoublesFromPairs(indexedPairs);
                        return (
                          <p className="text-xs text-emerald-400">
                            Detected <strong>{doubles.size}</strong> doubled pairs ready to
                            apply.
                          </p>
                        );
                      })()}
                      <button
                        className={`${cls.primaryBtn} mt-2`}
                        onClick={handleApplyParsed}
                      >
                        Apply to Matrix ↓
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </details>

          {/* Matrix grid (horizontal scroll on mobile) */}
          <div className="overflow-x-auto -mx-2 px-2 mt-2">
            <div className="inline-block min-w-fit">
              <div className="flex">
                <div className="w-10 sm:w-[42px] min-w-[2.5rem] sm:min-w-[42px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-semibold border border-slate-800 box-border sticky left-0 z-20" />
                {teams.map((t, i) => (
                  <div
                    key={i}
                    className="w-10 sm:w-[42px] min-w-[2.5rem] sm:min-w-[42px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-semibold border border-slate-800 box-border overflow-hidden whitespace-nowrap"
                  >
                    {abbrev(t)}
                  </div>
                ))}
              </div>
              {teams.map((t, i) => (
                <div key={i} className="flex">
                  <div className="w-10 sm:w-[42px] min-w-[2.5rem] sm:min-w-[42px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-semibold border border-slate-800 box-border sticky left-0 z-10 overflow-hidden whitespace-nowrap">
                    {abbrev(t)}
                  </div>
                  {teams.map((_, j) => {
                    if (j <= i) {
                      return (
                        <div
                          key={j}
                          className="w-10 sm:w-[42px] min-w-[2.5rem] sm:min-w-[42px] h-7 bg-slate-900 border border-slate-800 box-border"
                        />
                      );
                    }
                    const at = cellAvoidType(i, j);
                    const isManual = manualDoubles.has(pairKey(i, j));
                    let cellTone = "bg-slate-800 text-slate-500 hover:bg-slate-700";
                    let glyph = "";
                    if (isManual) {
                      cellTone = "bg-emerald-900 text-emerald-400 font-bold";
                      glyph = "✕";
                    } else if (at === "hard") {
                      cellTone = "bg-red-950 text-red-400 font-bold";
                      glyph = "H";
                    } else if (at === "soft") {
                      cellTone = "bg-amber-950 text-amber-400 font-semibold";
                      glyph = "S";
                    }
                    return (
                      <button
                        key={j}
                        type="button"
                        onClick={() => toggleDouble(i, j)}
                        className={`w-10 sm:w-[42px] min-w-[2.5rem] sm:min-w-[42px] h-7 flex items-center justify-center text-[10px] border border-slate-800 box-border cursor-pointer select-none ${cellTone}`}
                      >
                        {glyph}
                      </button>
                    );
                  })}
                </div>
              ))}
              <div className="flex">
                <div className="w-10 sm:w-[42px] min-w-[2.5rem] sm:min-w-[42px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-semibold border border-slate-800 box-border sticky left-0 z-10">
                  CT
                </div>
                {doublesPerTeam().map((c, i) => (
                  <div
                    key={i}
                    className={`w-10 sm:w-[42px] min-w-[2.5rem] sm:min-w-[42px] h-7 flex items-center justify-center bg-slate-900 text-[8px] font-semibold border border-slate-800 box-border ${
                      c === FORMAT.doublesPerTeam
                        ? "text-emerald-400"
                        : c > FORMAT.doublesPerTeam
                          ? "text-red-400"
                          : c === 0
                            ? "text-slate-600"
                            : "text-slate-400"
                    }`}
                  >
                    {c}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <p className="text-[10px] text-slate-500 mt-2">
            <span className="text-emerald-400">✕</span> manual{"  "}
            <span className="text-red-400">H</span> hard avoid (last {FORMAT.lookback.hard}{" "}
            season{FORMAT.lookback.hard > 1 ? "s" : ""}){"  "}
            <span className="text-amber-400">S</span> soft avoid (older)
          </p>

          {/* Mobile-friendly per-team summary */}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
              Per-team avoidance list
            </summary>
            <div className="mt-2 flex flex-col gap-1">
              {teams.map((t, i) => {
                const partners: { name: string; tone: string }[] = [];
                for (let j = 0; j < TEAM_COUNT; j++) {
                  if (j === i) continue;
                  const at = cellAvoidType(i, j);
                  const isManual = manualDoubles.has(pairKey(i, j));
                  if (isManual) {
                    partners.push({ name: teams[j]!, tone: "text-emerald-400" });
                  } else if (at === "hard") {
                    partners.push({ name: teams[j]!, tone: "text-red-400" });
                  } else if (at === "soft") {
                    partners.push({ name: teams[j]!, tone: "text-amber-400" });
                  }
                }
                if (partners.length === 0) return null;
                return (
                  <div
                    key={i}
                    className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs px-2 py-1 bg-slate-900 rounded"
                  >
                    <span className="text-slate-200 font-semibold min-w-[5rem]">{t}</span>
                    {partners.map((p, k) => (
                      <span key={k} className={p.tone}>
                        {p.name}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
          </details>

          <div className="flex gap-3 mt-5 flex-wrap">
            <button
              className={cls.secondaryBtn}
              onClick={() => setManualDoubles(new Set())}
            >
              Clear Manual
            </button>
            <button className={cls.primaryBtn} onClick={handleGenerate}>
              Generate Schedule →
            </button>
          </div>
          {genError && <p className={cls.error}>{genError}</p>}
        </div>
      )}

      {/* ═══ STEP 3: SCHEDULE ═══ */}
      {step === "schedule" && schedule && (
        <div className={cls.card}>
          <h2 className={cls.cardTitle}>Generated Schedule</h2>

          {schedule.hardRepeated.length > 0 && (
            <div className="bg-amber-950 border border-amber-800 rounded-md px-3 py-2 text-[11px] text-amber-400 mb-3">
              ⚠ {schedule.hardRepeated.length} hard-avoid pair(s) couldn&apos;t be skipped
              (marked ★). This shouldn&apos;t happen with clean history.
            </div>
          )}
          {schedule.softRepeated.length > 0 && (
            <p className="text-[11px] text-slate-400 mb-3">
              {schedule.softRepeated.length} pair(s) repeated from older seasons — this is
              expected to maintain the rotation.
            </p>
          )}

          <div className="flex gap-1 flex-wrap mb-4">
            {schedule.weeks.map((_: Matching, i: number) => (
              <button
                key={i}
                onClick={() => setSelectedWeek(i)}
                className={`w-8 h-7 sm:w-[34px] sm:h-[30px] flex items-center justify-center rounded text-xs font-mono cursor-pointer border ${
                  selectedWeek === i
                    ? "bg-emerald-800 border-emerald-600 text-emerald-50"
                    : "bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500"
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>

          <div className="bg-slate-900 border border-slate-700 rounded-lg p-4">
            <h3 className="text-sm font-bold text-emerald-50 mb-3">Week {selectedWeek + 1}</h3>
            <div className="flex flex-col gap-2">
              {schedule.weeks[selectedWeek]!.map(([a, b]: [number, number], gi: number) => {
                const isDouble = schedule.doubledPairs.has(pairKey(a, b));
                const isRepeat = schedule.hardRepeated.includes(pairKey(a, b));
                return (
                  <div
                    key={gi}
                    className="flex items-center gap-2.5 px-2.5 py-1.5 bg-slate-800 rounded-md border border-slate-700"
                  >
                    <span className="flex-1 text-[13px] text-slate-200 text-center">
                      {teams[a]}
                    </span>
                    <span
                      className={`text-[11px] font-bold ${isDouble ? "text-emerald-400" : "text-slate-600"}`}
                    >
                      vs
                    </span>
                    <span className="flex-1 text-[13px] text-slate-200 text-center">
                      {teams[b]}
                    </span>
                    {isRepeat && <span className="text-amber-400 text-sm ml-1">★</span>}
                  </div>
                );
              })}
            </div>
          </div>

          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
              Double Matchup Summary
            </summary>
            <div className="flex flex-col gap-1 mt-2">
              {teams.map((t, i) => {
                const partners: string[] = [];
                schedule.doubledPairs.forEach((key) => {
                  const [a, b] = unpackPairKey(key);
                  if (a === i) partners.push(teams[b]!);
                  if (b === i) partners.push(teams[a]!);
                });
                return (
                  <div
                    key={i}
                    className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs px-2 py-1 bg-slate-900 rounded"
                  >
                    <span className="text-slate-200 font-semibold min-w-[6.25rem]">{t}</span>
                    <span className="text-emerald-400">{partners.join(", ")}</span>
                  </div>
                );
              })}
            </div>
          </details>

          <div className="flex gap-3 mt-6 flex-wrap items-center">
            <button className={cls.secondaryBtn} onClick={handleGenerate}>
              Re-generate
            </button>
            {!saved ? (
              <button className={cls.primaryBtn} onClick={handleSaveSeason}>
                Save & Lock Season
              </button>
            ) : (
              <span className="text-emerald-400 text-[13px] font-semibold">
                ✓ Saved — this season&apos;s doubles feed next year&apos;s avoidance
              </span>
            )}
          </div>

          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
              Copy Full Schedule as Text
            </summary>
            <textarea
              readOnly
              className="w-full bg-slate-900 text-slate-400 border border-slate-700 rounded-md p-2.5 text-[11px] font-mono resize-y mt-2 box-border"
              value={schedule.weeks
                .map(
                  (week: Matching, wi: number) =>
                    `Week ${wi + 1}\n` +
                    week
                      .map(([a, b]: [number, number]) => `  ${teams[a]}  vs  ${teams[b]}`)
                      .join("\n"),
                )
                .join("\n\n")}
              rows={12}
              onClick={(e: MouseEvent<HTMLTextAreaElement>) =>
                (e.target as HTMLTextAreaElement).select()
              }
            />
          </details>
        </div>
      )}

      {step === "schedule" && !schedule && (
        <div className={cls.card}>
          <p className={cls.hint}>
            No schedule generated yet. Go to step 2 and click Generate.
          </p>
        </div>
      )}

      {history.length > 0 && (
        <details className="max-w-[700px] mx-auto mt-6">
          <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
            Season History ({history.length} saved)
          </summary>
          {history.map((h, si) => {
            const age = history.length - si;
            const tone =
              age <= FORMAT.lookback.hard
                ? "text-red-400"
                : age <= FORMAT.lookback.hard + FORMAT.lookback.soft
                  ? "text-amber-400"
                  : "text-slate-600";
            const label =
              age <= FORMAT.lookback.hard
                ? "HARD AVOID"
                : age <= FORMAT.lookback.hard + FORMAT.lookback.soft
                  ? "SOFT AVOID"
                  : "ROTATED OUT";
            return (
              <div
                key={si}
                className="px-2 py-1.5 border-b border-slate-700 text-xs flex flex-wrap gap-2"
              >
                <strong className="text-slate-200">{h.season}</strong>
                <span className="text-slate-400">
                  {(h.doubles || []).length} doubled pairs
                </span>
                <span className={`text-[10px] ${tone}`}>{label}</span>
              </div>
            );
          })}
          {!confirmClear ? (
            <button
              className={`${cls.secondaryBtn} mt-3 text-xs`}
              onClick={() => setConfirmClear(true)}
            >
              Clear History
            </button>
          ) : (
            <div className="mt-3 flex gap-2 items-center flex-wrap">
              <span className="text-[11px] text-red-400">Clear all history?</span>
              <button
                className="bg-red-600 text-emerald-50 border-0 px-2.5 py-1 rounded-md text-[11px] font-semibold cursor-pointer hover:bg-red-500"
                onClick={() => {
                  setHistory([]);
                  setManualDoubles(new Set());
                  setSaved(false);
                  setConfirmClear(false);
                  saveToStorage({ history: [], manualDoubles: [] });
                }}
              >
                Yes
              </button>
              <button
                className="bg-transparent text-slate-400 border border-slate-600 rounded-md px-2.5 py-1 text-[11px] cursor-pointer"
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
            </div>
          )}
        </details>
      )}

      <div className="max-w-[700px] mx-auto mt-6 text-center">
        {!confirmReset ? (
          <button
            className="bg-transparent text-slate-500 border border-slate-700 px-3 py-1.5 rounded-md text-[11px] cursor-pointer hover:text-slate-400 hover:border-slate-600"
            onClick={() => setConfirmReset(true)}
          >
            Reset Everything
          </button>
        ) : (
          <div className="inline-flex gap-2 items-center flex-wrap justify-center">
            <span className="text-[11px] text-red-400">
              Clear all data? Cannot be undone.
            </span>
            <button
              className="bg-red-600 text-emerald-50 border-0 px-3.5 py-1.5 rounded-md text-[11px] font-semibold cursor-pointer hover:bg-red-500"
              onClick={handleResetEverything}
            >
              Yes, reset
            </button>
            <button
              className="bg-transparent text-slate-400 border border-slate-600 rounded-md px-3.5 py-1.5 text-[11px] cursor-pointer"
              onClick={() => setConfirmReset(false)}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
