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
const STEP_ORDER = ["teams", "doubles", "schedule"] as const;

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

function formatImportSuccess(seasons: ImportedSeasonRecord[], format: SelectedFormat): string {
  const count = seasons.length;
  const years = seasons.map((s) => s.seasonYear || "?").join(", ");
  const leagueLabel = (seasons[0]?.seasonName || "").trim();
  const formatLabel = `${format.teamCount}-team / ${format.weekCount}-week`;
  const headline = leagueLabel
    ? `${leagueLabel} (${formatLabel})`
    : `${formatLabel} play`;
  return `Fetched ${count} season${count > 1 ? "s" : ""} of ${headline}: ${years}.`;
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

type ImportPlatform = "sleeper" | "espn" | "yahoo";

type ImportPreview = {
  platform: ImportPlatform;
  seasons: ImportedSeasonRecord[];
};

type ImportStatus = "" | "loading" | "ready" | "error";

type YahooLeagueOption = {
  leagueKey: string;
  name: string;
  season: string;
  numTeams: number;
};

type Step = "teams" | "doubles" | "schedule";

// ── Component ─────────────────────────────────────────────

export default function GeneratePage() {
  const [step, setStep] = useState<Step>("teams");
  const [furthestStep, setFurthestStep] = useState<Step>("teams");
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
  // Human-readable league name from the import (Sleeper/ESPN/Yahoo all surface
  // it on each season record). Used in step headings and the share payload.
  const [leagueName, setLeagueName] = useState<string>("");
  const [manualDoubles, setManualDoubles] = useState<Set<PairKey>>(() => new Set());
  const [schedule, setSchedule] = useState<ScheduleSuccess | null>(null);
  const [history, setHistory] = useState<SeasonHistory[]>([]);
  const [lookbackOverride, setLookbackOverride] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [genError, setGenError] = useState("");
  const [selectedWeek, setSelectedWeek] = useState(0);
  const [saved, setSaved] = useState(false);

  const [confirmReset, setConfirmReset] = useState(false);

  // Share-link state. Cleared whenever the schedule is regenerated so users
  // don't share a URL that points to the previous schedule.
  const [shareStatus, setShareStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [shareUrl, setShareUrl] = useState("");
  const [shareError, setShareError] = useState("");
  const [shareCopied, setShareCopied] = useState(false);

  // League import (server-side via /api/import/<platform>)
  const [platform, setPlatform] = useState<ImportPlatform>("sleeper");
  const [leagueId, setLeagueId] = useState("");
  const [importStatus, setImportStatus] = useState<ImportStatus>("");
  const [importMsg, setImportMsg] = useState("");

  // Shared preview - Fetch populates this; Apply commits it.
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);

  // Yahoo flow: leagues list (after connect), selected league key (for picker).
  const [yahooLeagues, setYahooLeagues] = useState<YahooLeagueOption[] | null>(null);
  const [selectedYahooLeague, setSelectedYahooLeague] = useState<string>("");

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
          if (typeof d.leagueName === "string") setLeagueName(d.leagueName);
          setFurthestStep("doubles");
        }
      }
    } catch {
      // Ignore corrupt storage; fall back to empty state.
    }
    setLoading(false);
  }, []);

  // Yahoo OAuth callback hand-off. The callback route redirects to
  // /?yahoo=connected on success or /?yahoo=error&reason=... on failure. We
  // strip the params, switch to the Yahoo platform, and either auto-load
  // leagues or surface the error message.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("yahoo");
    if (!status) return;
    const reason = params.get("reason");
    const url = new URL(window.location.href);
    url.searchParams.delete("yahoo");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", url.toString());

    setPlatform("yahoo");
    if (status === "connected") {
      void fetchYahooLeagues();
    } else if (status === "error") {
      setImportStatus("error");
      setImportMsg(`Yahoo connection failed: ${(reason || "unknown").replace(/_/g, " ")}.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        leagueName: string;
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
          leagueName,
          ...extra,
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // Storage may be full or unavailable; ignore.
      }
    },
    [teams, userIds, history, manualDoubles, selectedFormat, lookbackOverride, leagueName],
  );

  const recommendedLookbackTotal = format ? format.lookback.hard + format.lookback.soft : 0;
  // Override may only dial the lookback down. Anything higher than the per-format
  // recommendation gets clamped so an over-constrained avoid set can't sneak in
  // from stale localStorage either.
  const effectiveLookbackTotal = Math.min(
    lookbackOverride ?? recommendedLookbackTotal,
    recommendedLookbackTotal,
  );
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
    setShareStatus("idle");
    setShareUrl("");
    setShareError("");
    setShareCopied(false);
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
    setFurthestStep("schedule");
  }

  async function handleSaveAndShare() {
    if (!schedule || !selectedFormat) return;

    // Save once per generated schedule. Subsequent clicks just re-share so the
    // history doesn't accumulate duplicate entries.
    let nextHistory = history;
    let nextManualDoubles: PairKey[] = [...manualDoubles];
    if (!saved) {
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
      nextHistory = [...history, entry];
      nextManualDoubles = [];
      setHistory(nextHistory);
      setManualDoubles(new Set());
      saveToStorage({ history: nextHistory, manualDoubles: [] });
      setSaved(true);
    }

    setShareStatus("loading");
    setShareError("");
    setShareCopied(false);
    try {
      const payload = {
        format: selectedFormat,
        leagueName,
        teams,
        userIds,
        history: nextHistory,
        manualDoubles: nextManualDoubles,
        schedule: {
          weeks: schedule.weeks,
          doubledPairs: [...schedule.doubledPairs],
          softRepeated: schedule.softRepeated,
          hardRepeated: schedule.hardRepeated,
          clean: schedule.clean,
          format: schedule.format,
        },
      };
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const fullUrl = `${window.location.origin}${data.url}`;
      setShareUrl(fullUrl);
      setShareStatus("ready");
    } catch (e) {
      setShareStatus("error");
      setShareError((e as Error).message || "Share failed.");
    }
  }

  async function handleCopyShareLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); leave the URL
      // selectable in the input as fallback.
    }
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
    setImportStatus("");
    setImportMsg("");
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

  async function handleFetch() {
    if (!leagueId.trim()) return;
    const platformLabel = platform === "sleeper" ? "Sleeper" : "ESPN";
    setImportStatus("loading");
    setImportMsg(`Fetching from ${platformLabel}…`);
    setImportPreview(null);
    try {
      const res = await fetch(`/api/import/${platform}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueId: leagueId.trim() }),
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
      setImportPreview({ platform, seasons: detected.seasons });
      setImportStatus("ready");
      setImportMsg(formatImportSuccess(detected.seasons, detected.detected));
    } catch (e) {
      setImportStatus("error");
      setImportMsg((e as Error).message || "Fetch failed.");
    }
  }

  // Yahoo helpers ─ separate from handleFetch because the flow is two-step:
  // first list the user's leagues (no body), then fetch a chosen league's
  // season chain (with leagueKey). 401 means the user hasn't gone through
  // OAuth yet (or their refresh token expired); the UI shows Connect Yahoo.

  async function fetchYahooLeagueSeasons(leagueKey: string) {
    setImportStatus("loading");
    setImportMsg("Fetching season data from Yahoo…");
    setImportPreview(null);
    try {
      const res = await fetch("/api/import/yahoo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueKey }),
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
      setImportPreview({ platform: "yahoo", seasons: detected.seasons });
      setImportStatus("ready");
      setImportMsg(formatImportSuccess(detected.seasons, detected.detected));
    } catch (e) {
      setImportStatus("error");
      setImportMsg((e as Error).message || "Fetch failed.");
    }
  }

  async function fetchYahooLeagues() {
    setImportStatus("loading");
    setImportMsg("Loading Yahoo leagues…");
    setYahooLeagues(null);
    setSelectedYahooLeague("");
    setImportPreview(null);
    try {
      const res = await fetch("/api/import/yahoo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (res.status === 401) {
        // Treated as "not connected" — clear status so the Connect Yahoo
        // button shows. The user will run through OAuth to get a token.
        setYahooLeagues(null);
        setImportStatus("");
        setImportMsg("");
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const leagues = (data?.leagues || []) as YahooLeagueOption[];
      setYahooLeagues(leagues);
      if (leagues.length === 0) {
        setImportStatus("error");
        setImportMsg("No NFL leagues found on your Yahoo account.");
        return;
      }
      if (leagues.length === 1) {
        setSelectedYahooLeague(leagues[0]!.leagueKey);
        await fetchYahooLeagueSeasons(leagues[0]!.leagueKey);
        return;
      }
      setImportStatus("");
      setImportMsg(`Found ${leagues.length} Yahoo leagues — pick one.`);
    } catch (e) {
      setImportStatus("error");
      setImportMsg((e as Error).message || "Failed to load Yahoo leagues.");
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

      const candidateYear = season.seasonYear || String(new Date().getFullYear() - 1);
      const candidateDoublesStr = [...importDoubles].sort().join(",");
      const isDuplicate = newHistory.some(
        (entry) =>
          entry.season === candidateYear &&
          [...entry.doubles].sort().join(",") === candidateDoublesStr,
      );
      if (!isDuplicate) {
        newHistory.push({
          season: candidateYear,
          doubles: importDoubles,
          format: hasUids ? "userid" : "index",
        });
      }
    }

    setHistory(newHistory);

    // Adopt the most recent season's league name. The Yahoo picker, ESPN's
    // settings.name, and Sleeper's league.name all flow through seasonName.
    const nextLeagueName = (mostRecent.seasonName || "").trim();
    if (nextLeagueName) setLeagueName(nextLeagueName);

    saveToStorage({
      history: newHistory,
      teams: nextTeams,
      userIds: nextUserIds,
      format: detected,
      ...(nextLeagueName ? { leagueName: nextLeagueName } : {}),
      ...(formatChanged ? { lookbackOverride: null } : {}),
    });

    setManualDoubles(new Set());
    setImportPreview(null);
    setLeagueId("");
    setImportStatus("");
    setImportMsg("");
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
    setLeagueName("");
    resetImportUi();
    setLeagueId("");
    setPlatform("sleeper");
    setYahooLeagues(null);
    setSelectedYahooLeague("");
    setStep("teams");
    setFurthestStep("teams");
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
  const importBusy = importStatus === "loading";

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
      <div className={cls.subSection}>
        <p className={cls.hint}>
          {platform === "sleeper" ? (
            <>
              Enter your league ID from sleeper.com/leagues/<strong>YOUR_ID</strong>
            </>
          ) : platform === "espn" ? (
            <>
              Enter your league ID from fantasy.espn.com/football/league?leagueId=
              <strong>YOUR_ID</strong> (public leagues only)
            </>
          ) : (
            <>Sign in with Yahoo to import your fantasy leagues.</>
          )}
        </p>
        <div className="flex flex-wrap gap-2 items-stretch">
          <select
            className="bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 font-mono outline-none focus:border-slate-500"
            value={platform}
            onChange={(e) => {
              const next = e.target.value as ImportPlatform;
              if (next === platform) return;
              setPlatform(next);
              setImportPreview(null);
              setImportStatus("");
              setImportMsg("");
              setYahooLeagues(null);
              setSelectedYahooLeague("");
              if (next === "yahoo") {
                void fetchYahooLeagues();
              }
            }}
          >
            <option value="sleeper">Sleeper</option>
            <option value="espn">ESPN</option>
            <option value="yahoo">Yahoo</option>
          </select>
          {platform === "yahoo" ? (
            yahooLeagues && yahooLeagues.length > 1 ? (
              <>
                <select
                  className={cls.leagueInput}
                  value={selectedYahooLeague}
                  onChange={(e) => setSelectedYahooLeague(e.target.value)}
                >
                  <option value="">— pick a league —</option>
                  {yahooLeagues.map((l) => (
                    <option key={l.leagueKey} value={l.leagueKey}>
                      {l.season ? `${l.season} — ` : ""}
                      {l.name}
                    </option>
                  ))}
                </select>
                <button
                  className={cls.primaryBtn}
                  onClick={() => fetchYahooLeagueSeasons(selectedYahooLeague)}
                  disabled={!selectedYahooLeague || importBusy}
                >
                  {importStatus === "loading" ? "Loading…" : "Use this league"}
                </button>
              </>
            ) : (
              <button
                className={cls.primaryBtn}
                onClick={() => {
                  window.location.href = "/api/auth/yahoo/start";
                }}
                disabled={importBusy}
              >
                {importStatus === "loading" ? "Loading…" : "Connect Yahoo"}
              </button>
            )
          ) : (
            <>
              <input
                className={cls.leagueInput}
                value={leagueId}
                onChange={(e) => {
                  setLeagueId(e.target.value);
                  if (importPreview) setImportPreview(null);
                  if (importStatus) {
                    setImportStatus("");
                    setImportMsg("");
                  }
                }}
                placeholder={
                  platform === "sleeper" ? "e.g. 924039458279227392" : "e.g. 123456789"
                }
              />
              <button
                className={cls.primaryBtn}
                onClick={handleFetch}
                disabled={!leagueId.trim() || importBusy}
              >
                {importStatus === "loading" ? "Fetching…" : "Fetch"}
              </button>
            </>
          )}
        </div>

        {importMsg && (
          <p className={`text-[11px] mt-2 ${statusToneClass(importStatus)}`}>{importMsg}</p>
        )}
      </div>

      {/* Shared import preview */}
      {importPreview && (
        <div className="mt-2.5 mb-3 px-3 py-2.5 bg-slate-800 rounded-md border border-emerald-700">
          <p className="text-xs text-slate-200 mb-1">
            Ready to apply: {importPreview.seasons.length} season
            {importPreview.seasons.length > 1 ? "s" : ""} from{" "}
            <strong className="text-emerald-400">
              {importPreview.platform.charAt(0).toUpperCase() + importPreview.platform.slice(1)}
            </strong>
            {importPreview.seasons[0]!.seasonName?.trim()
              ? ` (${importPreview.seasons[0]!.seasonName!.trim()})`
              : ""}
            .
          </p>
          <p className="text-[11px] text-slate-400 mb-2">
            Most recent: {importPreview.seasons[0]!.seasonYear || "unknown"}
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
            {selectedFormat && teams.some((t, i) => t !== `Team ${i + 1}`) && (
              <span className="text-[10px] text-slate-500">Keeps your custom names</span>
            )}
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
          Fair schedules for fantasy football leagues
        </p>
      </div>

      {!format ? (
        <div className={cls.card}>
          <h2 className={cls.cardTitle}>Import your league</h2>
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
            Use Reset below to clear and re-import a different league.
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
        ).map(([key, label]) => {
          const disabled = STEP_ORDER.indexOf(key) > STEP_ORDER.indexOf(furthestStep);
          return (
            <button
              key={key}
              onClick={() => setStep(key)}
              disabled={disabled}
              className={`bg-transparent border px-3.5 py-1.5 rounded-md text-xs font-mono cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
                step === key
                  ? "bg-emerald-800 border-emerald-600 text-emerald-50"
                  : "border-slate-700 text-slate-400 hover:border-slate-500"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* ═══ STEP 1: IMPORT ═══ */}
      {step === "teams" && (
        <div className={cls.card}>
          <h2 className={cls.cardTitle}>{leagueName || "Managers"}</h2>

          <p className={cls.hint}>
            Auto-filled after import. Edit to use real names if you prefer.
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
                setFurthestStep((prev) =>
                  STEP_ORDER.indexOf(prev) < STEP_ORDER.indexOf("doubles") ? "doubles" : prev,
                );
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
          <h2 className={cls.cardTitle}>{leagueName || "Review"}</h2>

          {history.length > 0 && (
            <div className="bg-slate-900 border border-slate-700 rounded-lg px-3.5 py-2.5 mb-4">
              <strong className="text-slate-200">Lookback Window</strong>
              <p className="mt-1 text-[11px] text-slate-400">
                Using last{" "}
                <strong className="text-slate-200">{effectiveLookbackTotal}</strong>{" "}
                season{effectiveLookbackTotal !== 1 ? "s" : ""} (recommended for {teamCount}-team /{" "}
                {weekCount}-week
                {effectiveLookbackTotal !== recommendedLookbackTotal && (
                  <span className="text-amber-400"> is {recommendedLookbackTotal}</span>
                )}
                ).
              </p>
              <div className="mt-2 flex flex-wrap gap-2 items-center text-[11px]">
                <label htmlFor="lookback-override" className="text-slate-500">
                  Override:
                </label>
                <select
                  id="lookback-override"
                  className="bg-slate-800 text-slate-200 border border-slate-600 rounded px-1.5 py-0.5 text-[11px] font-mono outline-none focus:border-slate-500"
                  value={effectiveLookbackTotal}
                  onChange={(e) => {
                    const next = parseInt(e.target.value, 10);
                    setLookbackOverride(next);
                    saveToStorage({ lookbackOverride: next });
                  }}
                >
                  {Array.from(
                    { length: Math.min(recommendedLookbackTotal, history.length) },
                    (_, i) => i + 1,
                  ).map((n) => (
                    <option key={n} value={n}>
                      {n === recommendedLookbackTotal ? `${n} (recommended)` : n}
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
                    const isLocked = at === "hard" || at === "soft";
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
                        disabled={isLocked}
                        className={`w-10 sm:w-[42px] min-w-[2.5rem] sm:min-w-[42px] h-7 flex items-center justify-center text-[10px] border border-slate-800 box-border select-none ${isLocked ? "cursor-not-allowed" : "cursor-pointer"} ${cellTone}`}
                      >
                        {glyph}
                      </button>
                    );
                  })}
                </div>
              ))}
              {manualDoubles.size > 0 && (
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
              )}
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
              className={
                manualDoubles.size === 0
                  ? cls.secondaryBtn
                  : "bg-transparent text-amber-400 border border-amber-700 px-4 py-2.5 rounded-md text-[13px] cursor-pointer hover:text-amber-300 hover:border-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
              }
              onClick={() => setManualDoubles(new Set())}
              disabled={manualDoubles.size === 0}
            >
              Clear Manual Overrides
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
          <h2 className={cls.cardTitle}>
            {leagueName ? `${leagueName} Schedule` : "Generated Schedule"}
          </h2>

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
              Regenerate
            </button>
            <button
              className={cls.primaryBtn}
              onClick={handleSaveAndShare}
              disabled={shareStatus === "loading"}
            >
              {shareStatus === "loading" ? "Saving…" : "Save & Share"}
            </button>
            {saved && (
              <span className="text-emerald-400 text-[13px] font-semibold">
                ✓ Season saved - history updated for next year
              </span>
            )}
          </div>

          {shareStatus === "ready" && shareUrl && (
            <div className="mt-3 px-3 py-2.5 bg-slate-900 rounded-md border border-emerald-700">
              <p className="text-[11px] text-slate-400 mb-2">
                Shareable read-only link (expires in 365 days):
              </p>
              <div className="flex gap-2 items-center flex-wrap">
                <input
                  readOnly
                  className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[12px] text-slate-200 font-mono outline-none"
                  value={shareUrl}
                  onClick={(e: MouseEvent<HTMLInputElement>) =>
                    (e.currentTarget as HTMLInputElement).select()
                  }
                />
                <button className={cls.secondaryBtn} onClick={handleCopyShareLink}>
                  {shareCopied ? "✓ Copied" : "Copy link"}
                </button>
              </div>
            </div>
          )}
          {shareStatus === "error" && shareError && (
            <p className={cls.error}>{shareError}</p>
          )}

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

      {step === "doubles" && history.length > 0 && (
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
        </details>
      )}
        </>
      )}

      {selectedFormat && (
        <div className="max-w-[700px] mx-auto mt-6 text-center">
          {!confirmReset ? (
            <button
              className="bg-transparent text-red-400 border border-red-700 px-3 py-1.5 rounded-md text-[11px] cursor-pointer hover:text-red-300 hover:border-red-600"
              onClick={() => setConfirmReset(true)}
            >
              Reset
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
      )}

      <footer className="max-w-[700px] mx-auto mt-4 text-center text-[11px] text-slate-500">
        <a
          href="https://github.com/shahirtaj/doublecheck/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-slate-400"
        >
          Report a bug
        </a>
        <span className="mx-2">·</span>
        <a
          href="https://buymeacoffee.com/shahirtaj"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-slate-400"
        >
          Buy me a coffee
        </a>
      </footer>
    </div>
  );
}
