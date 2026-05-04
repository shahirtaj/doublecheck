"use client";

import {
  useCallback,
  useEffect,
  useMemo,
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
  type LookbackWindow,
  type Matching,
  type PairKey,
  type SeasonHistory,
  type ScheduleSuccess,
} from "@/lib/algorithm";

// ── Format constants ──────────────────────────────────────
const STORAGE_KEY = "ff-rotational-scheduler";

type SelectedFormat = { teamCount: number; weekCount: number };

// Map a single-number lookback override (the total of hard + soft) back into
// the LookbackWindow shape buildAvoidMap expects. We preserve the format's
// hard count when possible, with any extra falling into soft.
function deriveLookback(override: number, formatLookback: LookbackWindow): LookbackWindow {
  const total = Math.max(0, Math.floor(override));
  const hard = Math.min(total, formatLookback.hard);
  const soft = Math.max(0, total - hard);
  return { hard, soft };
}

// Derive a format from an imported season record. Returns null if the season
// doesn't carry enough information (missing regWeeks, odd team count, or week
// count outside the round-robin range) for us to set the format from it.
function detectFormatFromImport(season: ImportedSeasonRecord): SelectedFormat | null {
  const teamCount = season.teamNames?.length ?? 0;
  const weekCount = season.regWeeks ?? 0;
  if (teamCount < 2 || teamCount % 2 !== 0) return null;
  if (weekCount < teamCount - 1 || weekCount > 2 * (teamCount - 1)) return null;
  return { teamCount, weekCount };
}

// ── Types ─────────────────────────────────────────────────

type ImportedSeasonRecord = {
  seasonYear?: string;
  seasonName?: string;
  teamNames: string[];
  userIds: (string | null)[];
  doubles: PairKey[];
  totalMatchups?: number;
  regWeeks?: number;
};

type ImportPlatform = "sleeper" | "espn";

type ImportPreview = {
  platform: ImportPlatform;
  seasons: ImportedSeasonRecord[];
};

type ImportStatus = "" | "loading" | "ready" | "error";

type Step = "teams" | "doubles" | "schedule";

// ── Component ─────────────────────────────────────────────

export default function GeneratePage() {
  const [step, setStep] = useState<Step>("teams");
  const [selectedFormat, setSelectedFormat] = useState<SelectedFormat | null>(null);
  const teamCount = selectedFormat?.teamCount ?? 0;
  const weekCount = selectedFormat?.weekCount ?? 0;
  const format = useMemo(
    () => (selectedFormat ? describeFormat(teamCount, weekCount) : null),
    [selectedFormat, teamCount, weekCount],
  );
  const isEdgeCaseFormat =
    !!format &&
    (format.variant === "pure-round-robin" || format.variant === "complete-double-round-robin");

  const [teams, setTeams] = useState<string[]>(() => []);
  const [userIds, setUserIds] = useState<(string | null)[]>(() => []);
  const [manualDoubles, setManualDoubles] = useState<Set<PairKey>>(() => new Set());
  const [schedule, setSchedule] = useState<ScheduleSuccess | null>(null);
  const [history, setHistory] = useState<SeasonHistory[]>([]);
  const [lookbackOverride, setLookbackOverride] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [genError, setGenError] = useState("");
  const [selectedWeek, setSelectedWeek] = useState(0);
  const [saved, setSaved] = useState(false);

  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // Sleeper import (server-side via /api/import/sleeper)
  const [sleeperId, setSleeperId] = useState("");
  const [sleeperStatus, setSleeperStatus] = useState<ImportStatus>("");
  const [sleeperMsg, setSleeperMsg] = useState("");

  // ESPN import (server-side via /api/import/espn)
  const [espnId, setEspnId] = useState("");
  const [espnStatus, setEspnStatus] = useState<ImportStatus>("");
  const [espnMsg, setEspnMsg] = useState("");

  // Shared preview - Sleeper / ESPN populate this; Apply commits it.
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);

  // Hydrate from localStorage on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        let storedTeamCount = 0;
        if (
          d.format &&
          typeof d.format.teamCount === "number" &&
          typeof d.format.weekCount === "number" &&
          d.format.teamCount >= 2 &&
          d.format.teamCount % 2 === 0
        ) {
          setSelectedFormat({ teamCount: d.format.teamCount, weekCount: d.format.weekCount });
          storedTeamCount = d.format.teamCount;
        }
        if (storedTeamCount > 0) {
          if (Array.isArray(d.teams) && d.teams.length === storedTeamCount) setTeams(d.teams);
          if (Array.isArray(d.userIds) && d.userIds.length === storedTeamCount) setUserIds(d.userIds);
          if (Array.isArray(d.history)) setHistory(d.history);
          if (Array.isArray(d.manualDoubles)) setManualDoubles(new Set(d.manualDoubles));
          if (typeof d.lookbackOverride === "number") setLookbackOverride(d.lookbackOverride);
        }
      }
    } catch {
      // Ignore corrupt storage; fall back to empty state.
    }
    setLoading(false);
  }, []);

  const saveToStorage = useCallback(
    (
      extra: Partial<{
        teams: string[];
        userIds: (string | null)[];
        history: SeasonHistory[];
        manualDoubles: PairKey[];
        format: SelectedFormat | null;
        lookbackOverride: number | null;
      }> = {},
    ) => {
      try {
        const payload = {
          teams,
          userIds,
          history,
          manualDoubles: [...manualDoubles],
          format: selectedFormat,
          lookbackOverride,
          ...extra,
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // Storage may be full or unavailable; ignore.
      }
    },
    [teams, userIds, history, manualDoubles, selectedFormat, lookbackOverride],
  );

  const recommendedLookbackTotal = format ? format.lookback.hard + format.lookback.soft : 0;
  const effectiveLookbackTotal = lookbackOverride ?? recommendedLookbackTotal;
  const effectiveLookback = useMemo<LookbackWindow>(
    () => (format ? deriveLookback(effectiveLookbackTotal, format.lookback) : { hard: 0, soft: 0 }),
    [effectiveLookbackTotal, format],
  );

  function getAvoidSets() {
    const { hard, soft } = buildAvoidMap(history, userIds, effectiveLookback);
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
      teamCount,
      weekCount,
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

  // ── Import handlers ──

  function resetImportUi() {
    setImportPreview(null);
    setSleeperStatus("");
    setSleeperMsg("");
    setEspnStatus("");
    setEspnMsg("");
  }

  // Filter imported seasons down to the format detected from the most recent
  // season. Older seasons with a different roster size are dropped because
  // their team-index space wouldn't line up with the detected format.
  function filterToDetectedFormat(seasons: ImportedSeasonRecord[]): {
    detected: SelectedFormat;
    seasons: ImportedSeasonRecord[];
  } | null {
    const detected = detectFormatFromImport(seasons[0]!);
    if (!detected) return null;
    const filtered = seasons.filter(
      (s) => s.teamNames?.length === detected.teamCount && s.regWeeks === detected.weekCount,
    );
    return { detected, seasons: filtered };
  }

  async function handleSleeperFetch() {
    if (!sleeperId.trim()) return;
    setSleeperStatus("loading");
    setSleeperMsg("Fetching from Sleeper…");
    setImportPreview(null);
    setEspnStatus("");
    setEspnMsg("");
    try {
      const res = await fetch("/api/import/sleeper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueId: sleeperId.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const seasons = data as ImportedSeasonRecord[];
      if (!Array.isArray(seasons) || seasons.length === 0) {
        throw new Error("No seasons returned.");
      }
      const detected = filterToDetectedFormat(seasons);
      if (!detected) {
        throw new Error(
          "Could not detect a valid league format from the most recent season (need an even team count and a regular-season week count).",
        );
      }
      setImportPreview({ platform: "sleeper", seasons: detected.seasons });
      setSleeperStatus("ready");
      setSleeperMsg(
        `Fetched ${detected.seasons.length} season${detected.seasons.length > 1 ? "s" : ""} of ${detected.detected.teamCount}-team / ${detected.detected.weekCount}-week play: ${detected.seasons
          .map((s) => s.seasonYear || "?")
          .join(", ")}.`,
      );
    } catch (e) {
      setSleeperStatus("error");
      setSleeperMsg((e as Error).message || "Fetch failed.");
    }
  }

  async function handleEspnFetch() {
    if (!espnId.trim()) return;
    setEspnStatus("loading");
    setEspnMsg("Fetching from ESPN…");
    setImportPreview(null);
    setSleeperStatus("");
    setSleeperMsg("");
    try {
      const res = await fetch("/api/import/espn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueId: espnId.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const seasons = data as ImportedSeasonRecord[];
      if (!Array.isArray(seasons) || seasons.length === 0) {
        throw new Error("No seasons returned.");
      }
      const detected = filterToDetectedFormat(seasons);
      if (!detected) {
        throw new Error(
          "Could not detect a valid league format from the most recent season (need an even team count and a regular-season week count).",
        );
      }
      setImportPreview({ platform: "espn", seasons: detected.seasons });
      setEspnStatus("ready");
      setEspnMsg(
        `Fetched ${detected.seasons.length} season${detected.seasons.length > 1 ? "s" : ""} of ${detected.detected.teamCount}-team / ${detected.detected.weekCount}-week play: ${detected.seasons
          .map((s) => s.seasonYear || "?")
          .join(", ")}.`,
      );
    } catch (e) {
      setEspnStatus("error");
      setEspnMsg((e as Error).message || "Fetch failed.");
    }
  }

  function handleApplyImport() {
    if (!importPreview || importPreview.seasons.length === 0) return;
    const mostRecent = importPreview.seasons[0]!;
    const detected = detectFormatFromImport(mostRecent);
    if (!detected) return;

    // Format-changing imports replace roster + history outright. Same-format
    // imports preserve any custom names the user has already set.
    const formatChanged =
      !selectedFormat ||
      selectedFormat.teamCount !== detected.teamCount ||
      selectedFormat.weekCount !== detected.weekCount;

    let nextTeams = teams;
    if (formatChanged) {
      nextTeams = mostRecent.teamNames;
      setTeams(nextTeams);
      setSelectedFormat(detected);
      setLookbackOverride(null);
    } else {
      const hasCustomNames = teams.some((t, i) => t !== `Team ${i + 1}`);
      if (!hasCustomNames) {
        nextTeams = mostRecent.teamNames;
        setTeams(nextTeams);
      }
    }
    const nextUserIds = mostRecent.userIds;
    setUserIds(nextUserIds);

    // Server returns most-recent-first; history stores oldest-first. When the
    // format changes we drop existing history because its team indices belong
    // to a different roster size.
    const seasonsOldestFirst = [...importPreview.seasons].reverse();
    const newHistory: SeasonHistory[] = formatChanged ? [] : [...history];
    for (const season of seasonsOldestFirst) {
      const sUserIds = season.userIds;
      const hasUids = sUserIds.some((id) => id != null);
      let importDoubles: PairKey[];
      if (hasUids) {
        importDoubles = season.doubles.map((key) => {
          const [a, b] = unpackPairKey(key);
          return [sUserIds[a], sUserIds[b]].sort().join(":");
        });
      } else {
        importDoubles = season.doubles;
      }

      const lastEntry = newHistory[newHistory.length - 1];
      const lastDoublesStr = lastEntry ? [...lastEntry.doubles].sort().join(",") : "";
      const newDoublesStr = [...importDoubles].sort().join(",");
      if (lastDoublesStr !== newDoublesStr) {
        newHistory.push({
          season: season.seasonYear || String(new Date().getFullYear() - 1),
          doubles: importDoubles,
          format: hasUids ? "userid" : "index",
        });
      }
    }

    setHistory(newHistory);
    saveToStorage({
      history: newHistory,
      teams: nextTeams,
      userIds: nextUserIds,
      format: detected,
      ...(formatChanged ? { lookbackOverride: null } : {}),
    });

    setManualDoubles(new Set());
    setImportPreview(null);
    setSleeperId("");
    setEspnId("");
    setSleeperStatus("");
    setSleeperMsg("");
    setEspnStatus("");
    setEspnMsg("");
  }

  // ── Derived helpers ──

  function doublesPerTeam() {
    const counts = Array(teamCount).fill(0);
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
    const { hard, soft } = buildAvoidMap(history, userIds, effectiveLookback);
    if (hard.has(key)) return "hard";
    if (soft.has(key)) return "soft";
    return "none";
  }

  function handleResetEverything() {
    setSelectedFormat(null);
    setTeams([]);
    setUserIds([]);
    setHistory([]);
    setManualDoubles(new Set());
    setSchedule(null);
    setSaved(false);
    setLookbackOverride(null);
    resetImportUi();
    setSleeperId("");
    setEspnId("");
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
  const importBusy =
    sleeperStatus === "loading" || espnStatus === "loading";

  // ── Tailwind class atoms (mirrors the prototype's S object) ──

  const cls = {
    primaryBtn:
      "bg-gradient-to-br from-emerald-600 to-emerald-700 text-emerald-50 border-0 px-5 py-2.5 rounded-md text-[13px] font-semibold cursor-pointer hover:from-emerald-500 hover:to-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed",
    secondaryBtn:
      "bg-transparent text-slate-400 border border-slate-600 px-4 py-2.5 rounded-md text-[13px] cursor-pointer hover:border-slate-500 hover:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed",
    card: "bg-slate-800 border border-slate-700 rounded-xl p-5 max-w-[700px] mx-auto",
    cardTitle: "text-base font-bold text-emerald-50 mb-1.5",
    hint: "text-xs text-slate-400 leading-relaxed mb-3",
    subSection: "bg-slate-900 border border-slate-700 rounded-lg p-3.5 mb-3",
    sectionTitle: "text-[13px] font-bold text-slate-200 mb-1.5",
    teamInput:
      "flex-1 bg-transparent border-0 outline-none text-slate-200 text-[13px] font-mono py-1",
    error: "text-red-400 text-xs mt-3",
    leagueInput:
      "flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 font-mono outline-none focus:border-slate-500",
  };

  function statusToneClass(status: ImportStatus): string {
    if (status === "error") return "text-red-400";
    if (status === "ready") return "text-emerald-400";
    return "text-slate-400";
  }

  const importSections = (
    <>
      {/* Sleeper */}
      <div className={cls.subSection}>
        <h3 className={cls.sectionTitle}>Import from Sleeper</h3>
        <p className={cls.hint}>
          Enter your current Sleeper league ID - the server walks the history chain to find
          completed seasons. Find it in your league URL: sleeper.com/leagues/
          <strong>YOUR_ID</strong>
        </p>
        <div className="flex flex-wrap gap-2 items-stretch">
          <input
            className={cls.leagueInput}
            value={sleeperId}
            onChange={(e) => {
              setSleeperId(e.target.value);
              if (importPreview?.platform === "sleeper") setImportPreview(null);
              if (sleeperStatus) {
                setSleeperStatus("");
                setSleeperMsg("");
              }
            }}
            placeholder="e.g. 924039458279227392"
          />
          <button
            className={cls.primaryBtn}
            onClick={handleSleeperFetch}
            disabled={!sleeperId.trim() || importBusy}
          >
            {sleeperStatus === "loading" ? "Fetching…" : "Fetch"}
          </button>
        </div>

        {sleeperMsg && (
          <p className={`text-[11px] mt-2 ${statusToneClass(sleeperStatus)}`}>{sleeperMsg}</p>
        )}
      </div>

      {/* ESPN */}
      <div className={cls.subSection}>
        <h3 className={cls.sectionTitle}>Import from ESPN</h3>
        <p className={cls.hint}>
          Public leagues only for now. Find your league ID in the URL:
          fantasy.espn.com/football/league?leagueId=<strong>YOUR_ID</strong>.
        </p>
        <div className="flex flex-wrap gap-2 items-stretch">
          <input
            className={cls.leagueInput}
            value={espnId}
            onChange={(e) => {
              setEspnId(e.target.value);
              if (importPreview?.platform === "espn") setImportPreview(null);
              if (espnStatus) {
                setEspnStatus("");
                setEspnMsg("");
              }
            }}
            placeholder="e.g. 123456789"
          />
          <button
            className={cls.primaryBtn}
            onClick={handleEspnFetch}
            disabled={!espnId.trim() || importBusy}
          >
            {espnStatus === "loading" ? "Fetching…" : "Fetch"}
          </button>
        </div>

        {espnMsg && (
          <p className={`text-[11px] mt-2 ${statusToneClass(espnStatus)}`}>{espnMsg}</p>
        )}
      </div>

      {/* Yahoo placeholder */}
      <div className={`${cls.subSection} opacity-60`}>
        <h3 className={cls.sectionTitle}>
          Yahoo <span className="text-[10px] text-slate-500 font-normal">(coming soon)</span>
        </h3>
        <p className={cls.hint}>
          Yahoo requires OAuth 2.0 with a registered developer app - landing in a follow-up
          phase.
        </p>
      </div>

      {/* Shared import preview */}
      {importPreview && (
        <div className="mt-2.5 mb-3 px-3 py-2.5 bg-slate-800 rounded-md border border-emerald-700">
          <p className="text-xs text-slate-200 mb-1">
            Ready to apply: {importPreview.seasons.length} season
            {importPreview.seasons.length > 1 ? "s" : ""} from{" "}
            <strong className="text-emerald-400">{importPreview.platform.toUpperCase()}</strong>
            .
          </p>
          <p className="text-[11px] text-slate-400 mb-2">
            Most recent: {importPreview.seasons[0]!.seasonYear || "unknown"} -{" "}
            {importPreview.seasons[0]!.doubles.length} doubled pairs across{" "}
            {importPreview.seasons[0]!.regWeeks ?? "?"} weeks ·{" "}
            {importPreview.seasons[0]!.teamNames.length}-team format.
          </p>
          <p className="text-[11px] text-slate-500 mb-2">
            Managers: {importPreview.seasons[0]!.teamNames.join(", ")}
          </p>
          <div className="flex gap-2 flex-wrap items-center">
            <button className={cls.primaryBtn} onClick={handleApplyImport}>
              Apply
            </button>
            <button
              className={cls.secondaryBtn}
              onClick={() => setImportPreview(null)}
            >
              Cancel
            </button>
            <span className="text-[10px] text-slate-500">
              {selectedFormat && teams.some((t, i) => t !== `Team ${i + 1}`)
                ? "Keeps your custom names"
                : "Imports manager names"}
            </span>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="min-h-screen px-4 py-6 text-slate-200 font-mono">
      <div className="text-center mb-7">
        <h1 className="text-xl sm:text-2xl font-extrabold text-emerald-50 uppercase tracking-tight">
          DoubleCheck
        </h1>
        <p className="text-[11px] text-slate-500 mt-1 tracking-wider">
          Fair rotational schedules for fantasy football leagues
        </p>
      </div>

      {!format ? (
        <div className={cls.card}>
          <h2 className={cls.cardTitle}>Import a league to get started</h2>
          <p className={cls.hint}>
            DoubleCheck detects your league&apos;s format (team count and week count) from the
            seasons it imports. Connect Sleeper or ESPN below to begin - once import succeeds, the
            review and schedule steps appear.
          </p>
          {importSections}
        </div>
      ) : isEdgeCaseFormat ? (
        <div className={cls.card}>
          <h2 className={cls.cardTitle}>No schedule needed</h2>
          {format.variant === "pure-round-robin" ? (
            <p className={cls.hint}>
              Detected{" "}
              <strong className="text-slate-200">
                {teamCount}-team / {weekCount}-week
              </strong>
              : a pure round-robin where every team plays every opponent exactly once. There are no
              doubled matchups, so there&apos;s no fairness problem to solve and no rotational
              schedule needed.
            </p>
          ) : (
            <p className={cls.hint}>
              Detected{" "}
              <strong className="text-slate-200">
                {teamCount}-team / {weekCount}-week
              </strong>
              : a complete double round-robin where every team plays every opponent exactly twice.
              The schedule is fully determined - every pair is doubled - so there&apos;s no
              rotational fairness problem to solve.
            </p>
          )}
          <p className="text-[11px] text-slate-500 mt-3">
            Use Reset Everything below to clear and re-import a different league.
          </p>
        </div>
      ) : (
        <>

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
          <h2 className={cls.cardTitle}>Import Last Season(s)</h2>

          {importSections}

          <div className="flex items-center my-4 gap-3">
            <span className="text-[11px] text-slate-600 uppercase tracking-widest whitespace-nowrap w-full text-center border-t border-slate-700 pt-3">
              manager names
            </span>
          </div>

          <p className={cls.hint}>
            Auto-filled by Sleeper or ESPN imports, or enter manually. Overwrite with real names if
            you prefer those over usernames.
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
              <strong className="text-slate-200">Lookback Window</strong>
              <p className="mt-1 text-[11px] text-slate-400">
                Using last{" "}
                <strong className="text-slate-200">{effectiveLookbackTotal}</strong>{" "}
                season{effectiveLookbackTotal !== 1 ? "s" : ""} (recommended for {teamCount}-team /{" "}
                {weekCount}-week is {recommendedLookbackTotal}).
              </p>
              <div className="mt-2 flex flex-wrap gap-2 items-center text-[11px]">
                <label htmlFor="lookback-override" className="text-slate-500">
                  Override:
                </label>
                <select
                  id="lookback-override"
                  className="bg-slate-800 text-slate-200 border border-slate-600 rounded px-1.5 py-0.5 text-[11px] font-mono outline-none focus:border-slate-500"
                  value={lookbackOverride ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    const next = v === "" ? null : parseInt(v, 10);
                    setLookbackOverride(next);
                    saveToStorage({ lookbackOverride: next });
                  }}
                >
                  <option value="">Recommended ({recommendedLookbackTotal})</option>
                  {Array.from({ length: history.length }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <span className="text-slate-500">
                  ={" "}
                  <span className="text-red-400">{effectiveLookback.hard} hard</span>
                  {effectiveLookback.soft > 0 && (
                    <>
                      {" + "}
                      <span className="text-amber-400">{effectiveLookback.soft} soft</span>
                    </>
                  )}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-500">
                {history.length} season{history.length > 1 ? "s" : ""} in history ·{" "}
                {avoidInfo.hard} hard · {avoidInfo.soft} soft · {avoidInfo.total} total avoid pairs
              </p>
            </div>
          )}

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
                      c === format.doublesPerTeam
                        ? "text-emerald-400"
                        : c > format.doublesPerTeam
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
            <span className="text-red-400">H</span> hard avoid (last {effectiveLookback.hard}{" "}
            season{effectiveLookback.hard !== 1 ? "s" : ""}){"  "}
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
                for (let j = 0; j < teamCount; j++) {
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
              {schedule.softRepeated.length} pair(s) repeated from older seasons - this is
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
                ✓ Saved - this season&apos;s doubles feed next year&apos;s avoidance
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
              age <= effectiveLookback.hard
                ? "text-red-400"
                : age <= effectiveLookback.hard + effectiveLookback.soft
                  ? "text-amber-400"
                  : "text-slate-600";
            const label =
              age <= effectiveLookback.hard
                ? "HARD AVOID"
                : age <= effectiveLookback.hard + effectiveLookback.soft
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
        </>
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
