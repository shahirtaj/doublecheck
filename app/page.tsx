"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from "react";
import Link from "next/link";
import {
  buildAvoidMap,
  buildSchedule,
  describeFormat,
  pairKey,
  unpackPairKey,
  type LookbackWindow,
  type Matching,
  type PairKey,
  type RivalryPin,
  type RivalryPlacement,
  type SeasonHistory,
  type ScheduleSuccess,
} from "@/lib/algorithm";

// ── Format constants ──────────────────────────────────────
const STORAGE_KEY = "ff-rotational-scheduler";
const STEP_ORDER = ["teams", "doubles", "schedule"] as const;
// Captured once at module load and reused for every "current year" default
// and reset throughout the component (`PAST_SEASON_YEARS` is derived from
// these inside the component so it can size itself to the active format).
const CURRENT_YEAR = new Date().getFullYear();
const CURRENT_YEAR_STR = String(CURRENT_YEAR);

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

// Year shown in the step-3 heading, the copy-as-text export, and the share
// payload. Picks the most recent valid season year from history when it's at
// or beyond the current calendar year (so the just-saved year stays put);
// otherwise rolls forward to the next slot or the current year.
function deriveScheduleYear(history: SeasonHistory[]): number {
  const currentYear = new Date().getFullYear();
  if (history.length === 0) return currentYear;
  const lastYear = parseInt(history[history.length - 1]!.season, 10);
  if (Number.isNaN(lastYear)) return currentYear;
  if (lastYear >= currentYear) return lastYear;
  return Math.max(currentYear, lastYear + 1);
}

// "espn" needs to render as the full acronym; the other platforms are normal
// proper nouns and just want title-case.
function platformLabel(platform: ImportPlatform): string {
  if (platform === "espn") return "ESPN";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
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

type ImportPlatform = "sleeper" | "espn" | "yahoo" | "manual";

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

type SleeperLeagueOption = {
  leagueId: string;
  name: string;
  season: string;
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
  // Commissioner-supplied rivalry pins. In-session only — cleared on reset,
  // reimport, or starting a new manual flow.
  const [rivalryPins, setRivalryPins] = useState<RivalryPin[]>([]);
  const [pinTeamA, setPinTeamA] = useState<number>(0);
  const [pinTeamB, setPinTeamB] = useState<number>(1);
  // null = "any week"; integer in [1, weekCount] = specific week.
  const [pinWeek, setPinWeek] = useState<number | null>(null);
  // True between a successful "Pin" click and the user's next dropdown change.
  // Used to suppress the inline error/warning that would otherwise fire against
  // the just-added pin while the same teams stay selected.
  const [pinJustAdded, setPinJustAdded] = useState(false);
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
  // Mirrors `platform` so in-flight Yahoo fetches can detect when the user
  // has switched platforms mid-request and bail out instead of stomping on
  // the new platform's state.
  const platformRef = useRef<ImportPlatform>("sleeper");
  useEffect(() => {
    platformRef.current = platform;
  }, [platform]);
  const [leagueId, setLeagueId] = useState("");
  const [importStatus, setImportStatus] = useState<ImportStatus>("");
  const [importMsg, setImportMsg] = useState("");
  // Captured from import error responses (e.g. ESPN private-league 403) so the
  // UI can render a "See instructions" link alongside the error text. Auto-
  // clears whenever importStatus transitions away from "error".
  const [importHelpUrl, setImportHelpUrl] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears derived help link when the source status leaves the error state
    if (importStatus !== "error") setImportHelpUrl(null);
  }, [importStatus]);

  // Shared preview - Fetch populates this; Apply commits it.
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);

  // Yahoo flow: leagues list (after connect), selected league key (for picker).
  const [yahooLeagues, setYahooLeagues] = useState<YahooLeagueOption[] | null>(null);
  const [selectedYahooLeague, setSelectedYahooLeague] = useState<string>("");

  // Sleeper flow: when a non-numeric input is entered, the server returns the
  // user's current-year leagues. Multiple results surface the picker; a single
  // result auto-fetches its chain.
  const [sleeperLeagues, setSleeperLeagues] = useState<SleeperLeagueOption[] | null>(null);
  const [selectedSleeperLeague, setSelectedSleeperLeague] = useState<string>("");

  // Manual flow: for leagues on unsupported platforms (NFL.com, CBS, etc.).
  // User picks format and league name up-front, then enters past doubled pairs
  // by clicking a matrix grid in Step 2.
  const [manualLeagueName, setManualLeagueName] = useState<string>("");
  const [manualTeamCount, setManualTeamCount] = useState<number>(12);
  const [manualWeekCount, setManualWeekCount] = useState<number>(14);
  const [addingPastSeason, setAddingPastSeason] = useState<boolean>(false);
  const [pastSeasonYear, setPastSeasonYear] = useState<string>(CURRENT_YEAR_STR);
  const [pastSeasonDoubles, setPastSeasonDoubles] = useState<Set<PairKey>>(() => new Set());
  // null when adding a new season; otherwise the index in `history` we're editing.
  const [editingSeasonIndex, setEditingSeasonIndex] = useState<number | null>(null);

  // Header tooltip: rendered as a fixed-position div at the root of the
  // return so it escapes the matrix's overflow containers. The hovered
  // cell's bounding rect drives positioning; a 200ms delay before showing
  // matches the prior CSS tooltip behavior.
  const [tooltipInfo, setTooltipInfo] = useState<{ text: string; rect: DOMRect } | null>(
    null,
  );
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    };
  }, []);
  const showHeaderTooltip = useCallback((text: string, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = setTimeout(() => {
      setTooltipInfo({ text, rect });
    }, 200);
  }, []);
  const hideHeaderTooltip = useCallback(() => {
    if (tooltipTimerRef.current) {
      clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
    setTooltipInfo(null);
  }, []);

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
          // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from localStorage on mount
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

    // eslint-disable-next-line react-hooks/set-state-in-effect -- handles Yahoo OAuth redirect-back hand-off on mount
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
  // Years offered by the "Add Past Season" dropdown, sized to the format's
  // recommended lookback so we don't surface seasons that can't influence
  // schedule generation. Ends at CURRENT_YEAR - 1 because the current year is
  // the season being scheduled, not a past one. Empty until a format is
  // selected. Existing entries older than this window still appear in the
  // Season History list — this only narrows which years are addable.
  const PAST_SEASON_YEARS = format
    ? Array.from(
        { length: recommendedLookbackTotal },
        (_, i) => CURRENT_YEAR - recommendedLookbackTotal + i,
      )
    : [];
  // Override may only dial the lookback down. Anything higher than the per-format
  // recommendation gets clamped so an over-constrained avoid set can't sneak in
  // from stale localStorage either. The window is also capped at the number of
  // seasons we actually have, so the display and the dropdown's controlled value
  // never claim more lookback than history can supply.
  const effectiveLookbackTotal = Math.min(
    lookbackOverride ?? recommendedLookbackTotal,
    recommendedLookbackTotal,
    history.length,
  );
  const effectiveLookback = useMemo<LookbackWindow>(
    () => (format ? deriveLookback(effectiveLookbackTotal, format.lookback) : { hard: 0, soft: 0 }),
    [effectiveLookbackTotal, format],
  );
  const scheduleYear = useMemo(() => deriveScheduleYear(history), [history]);

  function getAvoidSets() {
    const { hard, soft } = buildAvoidMap(history, userIds, effectiveLookback);
    manualDoubles.forEach((key) => {
      hard.add(key);
      soft.delete(key);
    });
    return { hard, soft };
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
      rivalryPins,
    });
    if (!result.ok) {
      setGenError(
        result.reason === "generation-failed"
          ? rivalryPins.length > 0
            ? result.message
            : "Could not generate a valid schedule. Try clearing some avoid-pairs."
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
        seasonYear: scheduleYear,
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
          rivalryPlacements: schedule.rivalryPlacements,
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
    setSleeperLeagues(null);
    setSelectedSleeperLeague("");
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
    const filtered = seasons.filter((s) => s.teamNames?.length === detected.teamCount);
    return { detected, seasons: filtered };
  }

  async function handleFetch() {
    const input = leagueId.trim();
    if (!input) return;
    setImportPreview(null);
    setSleeperLeagues(null);
    setSelectedSleeperLeague("");

    // Sleeper accepts either a numeric league ID (existing chain flow) or a
    // username (look up user → list current-year leagues → picker). ESPN only
    // accepts league IDs.
    if (platform === "sleeper" && !/^\d+$/.test(input)) {
      setImportStatus("loading");
      setImportMsg(`Looking up Sleeper user "${input}"…`);
      try {
        const res = await fetch("/api/import/sleeper", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: input }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        const leagues = (data?.leagues || []) as SleeperLeagueOption[];
        if (leagues.length === 0) {
          throw new Error("No Sleeper NFL leagues found for this user.");
        }
        if (leagues.length === 1) {
          setSleeperLeagues(leagues);
          setSelectedSleeperLeague(leagues[0]!.leagueId);
          await fetchSleeperLeagueSeasons(leagues[0]!.leagueId);
          return;
        }
        setSleeperLeagues(leagues);
        setImportStatus("");
        setImportMsg(`Found ${leagues.length} Sleeper leagues - pick one.`);
      } catch (e) {
        setImportStatus("error");
        setImportMsg((e as Error).message || "Sleeper username lookup failed.");
      }
      return;
    }

    const platformLabel = platform === "sleeper" ? "Sleeper" : "ESPN";
    setImportStatus("loading");
    setImportMsg(`Fetching from ${platformLabel}…`);
    try {
      const res = await fetch(
        `/api/import/${platform}?seasons=${recommendedLookbackTotal}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leagueId: input }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        if (typeof data?.helpUrl === "string") setImportHelpUrl(data.helpUrl);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
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
      setImportMsg("");
    } catch (e) {
      setImportStatus("error");
      setImportMsg((e as Error).message || "Fetch failed.");
    }
  }

  async function fetchSleeperLeagueSeasons(specificLeagueId: string) {
    setImportStatus("loading");
    setImportMsg("Fetching season data from Sleeper…");
    setImportPreview(null);
    try {
      const res = await fetch(
        `/api/import/sleeper?seasons=${recommendedLookbackTotal}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leagueId: specificLeagueId }),
        },
      );
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
      setImportStatus("ready");
      setImportMsg("");
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
      const res = await fetch(
        `/api/import/yahoo?seasons=${recommendedLookbackTotal}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leagueKey }),
        },
      );
      if (platformRef.current !== "yahoo") return;
      const data = await res.json();
      if (platformRef.current !== "yahoo") return;
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
      setImportMsg("");
    } catch (e) {
      if (platformRef.current !== "yahoo") return;
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
      if (platformRef.current !== "yahoo") return;
      if (res.status === 401) {
        // Treated as "not connected" — clear status so the Connect Yahoo
        // button shows. The user will run through OAuth to get a token.
        setYahooLeagues(null);
        setImportStatus("");
        setImportMsg("");
        return;
      }
      const data = await res.json();
      if (platformRef.current !== "yahoo") return;
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
      setImportMsg(`Found ${leagues.length} Yahoo leagues - pick one.`);
    } catch (e) {
      if (platformRef.current !== "yahoo") return;
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
      setSelectedFormat(detected);
      setLookbackOverride(null);
    } else {
      const hasCustomNames = teams.some((t, i) => t !== `Team ${i + 1}`);
      if (!hasCustomNames) {
        nextTeams = mostRecent.teamNames;
      }
    }
    let nextUserIds: (string | null)[] = mostRecent.userIds;

    // Sort teams and userIds together by team name so index 0 is always
    // the alphabetically-first team from the moment of import. Indices
    // are assigned once, here — all downstream logic (algorithm, matrix,
    // storage) stays consistent with that assignment.
    const sortedPairs = nextTeams
      .map((name, i) => ({ name, userId: nextUserIds[i] ?? null }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    nextTeams = sortedPairs.map((p) => p.name);
    nextUserIds = sortedPairs.map((p) => p.userId);

    setTeams(nextTeams);
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
    setRivalryPins([]);
    setPinTeamA(0);
    setPinTeamB(1);
    setPinWeek(null);
  }

  function handleManualStart() {
    const tc = manualTeamCount;
    const wc = manualWeekCount;
    const name = manualLeagueName.trim();
    const initialTeams = Array.from({ length: tc }, (_, i) => `Team ${i + 1}`);
    const initialUserIds = Array.from({ length: tc }, () => null) as (string | null)[];
    // Mirror the handleApplyImport sort path so index 0 is always the
    // alphabetically-first team. No-op for the numbered defaults, but
    // keeps the code path consistent if the default naming changes.
    const sortedPairs = initialTeams
      .map((name, i) => ({ name, userId: initialUserIds[i] ?? null }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    const nextTeams = sortedPairs.map((p) => p.name);
    const nextUserIds = sortedPairs.map((p) => p.userId);
    setSelectedFormat({ teamCount: tc, weekCount: wc });
    setTeams(nextTeams);
    setUserIds(nextUserIds);
    setLeagueName(name);
    setHistory([]);
    setManualDoubles(new Set());
    setRivalryPins([]);
    setPinTeamA(0);
    setPinTeamB(1);
    setPinWeek(null);
    setSchedule(null);
    setSaved(false);
    setLookbackOverride(null);
    setStep("teams");
    setFurthestStep("teams");
    resetImportUi();
    saveToStorage({
      format: { teamCount: tc, weekCount: wc },
      teams: nextTeams,
      userIds: nextUserIds,
      leagueName: name,
      history: [],
      manualDoubles: [],
      lookbackOverride: null,
    });
  }

  function togglePastSeasonDouble(i: number, j: number) {
    const key = pairKey(i, j);
    const next = new Set(pastSeasonDoubles);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPastSeasonDoubles(next);
  }

  function handleApplyPastSeason() {
    const year = pastSeasonYear.trim();
    if (!year) return;
    let nextHistory: SeasonHistory[];
    if (editingSeasonIndex !== null) {
      const original = history[editingSeasonIndex];
      if (!original) return;
      let doubles: PairKey[] = [...pastSeasonDoubles];
      let format: "userid" | "index" = "index";
      // Preserve userid format when editing an imported season, but only if
      // every selected pair maps to a known userId. Otherwise fall back to
      // index format so we don't write keys that reference missing users.
      const allHaveUserIds = [...pastSeasonDoubles].every((key) => {
        const [a, b] = unpackPairKey(key);
        return userIds[a] != null && userIds[b] != null;
      });
      if (original.format === "userid" && allHaveUserIds) {
        doubles = [...pastSeasonDoubles].map((key) => {
          const [a, b] = unpackPairKey(key);
          return [userIds[a], userIds[b]].sort().join(":");
        });
        format = "userid";
      }
      const updated: SeasonHistory = { season: year, doubles, format };
      nextHistory = history.map((h, i) => (i === editingSeasonIndex ? updated : h));
    } else {
      const entry: SeasonHistory = {
        season: year,
        doubles: [...pastSeasonDoubles],
        format: "index",
      };
      nextHistory = [...history, entry].sort((a, b) => {
        const aN = Number(a.season);
        const bN = Number(b.season);
        if (Number.isNaN(aN) || Number.isNaN(bN)) return 0;
        return aN - bN;
      });
    }
    setHistory(nextHistory);
    saveToStorage({ history: nextHistory });
    setPastSeasonYear(CURRENT_YEAR_STR);
    setPastSeasonDoubles(new Set());
    setAddingPastSeason(false);
    setEditingSeasonIndex(null);
  }

  function handleCancelPastSeason() {
    setPastSeasonYear(CURRENT_YEAR_STR);
    setPastSeasonDoubles(new Set());
    setAddingPastSeason(false);
    setEditingSeasonIndex(null);
  }

  function handleStartAddSeason() {
    const used = new Set(history.map((h) => h.season));
    const available = PAST_SEASON_YEARS.filter((y) => !used.has(String(y)));
    if (available.length === 0) return;
    const defaultYear = String(available[available.length - 1]);
    setPastSeasonYear(defaultYear);
    setPastSeasonDoubles(new Set());
    setEditingSeasonIndex(null);
    setAddingPastSeason(true);
  }

  function handleStartEditSeason(index: number) {
    const entry = history[index];
    if (!entry) return;
    // Convert userid-format doubles back to index pair keys against the
    // current roster so the matrix can render and toggle them. Pairs that
    // reference users no longer in the league are silently dropped.
    const indexPairs = new Set<PairKey>();
    for (const key of entry.doubles ?? []) {
      if (entry.format === "userid") {
        const colon = key.indexOf(":");
        if (colon < 0) continue;
        const uid1 = key.slice(0, colon);
        const uid2 = key.slice(colon + 1);
        const i1 = userIds.indexOf(uid1);
        const i2 = userIds.indexOf(uid2);
        if (i1 < 0 || i2 < 0) continue;
        indexPairs.add(pairKey(i1, i2));
      } else {
        indexPairs.add(key);
      }
    }
    setPastSeasonYear(entry.season);
    setPastSeasonDoubles(indexPairs);
    setEditingSeasonIndex(index);
    setAddingPastSeason(true);
  }

  function handleDeleteSeason(index: number) {
    const nextHistory = history.filter((_, i) => i !== index);
    setHistory(nextHistory);
    saveToStorage({ history: nextHistory });
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
    return name.length > 7 ? name.slice(0, 7) : name;
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
    setRivalryPins([]);
    setPinTeamA(0);
    setPinTeamB(1);
    setPinWeek(null);
    setSchedule(null);
    setSaved(false);
    setLookbackOverride(null);
    setLeagueName("");
    resetImportUi();
    setLeagueId("");
    setPlatform("sleeper");
    setYahooLeagues(null);
    setSelectedYahooLeague("");
    setManualLeagueName("");
    setManualTeamCount(12);
    setManualWeekCount(14);
    setAddingPastSeason(false);
    setPastSeasonYear(CURRENT_YEAR_STR);
    setPastSeasonDoubles(new Set());
    setEditingSeasonIndex(null);
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

  const importBusy = importStatus === "loading";
  const usedSeasonYears = new Set(history.map((h) => h.season));
  const availablePastSeasonYears = PAST_SEASON_YEARS.filter(
    (y) => !usedSeasonYears.has(String(y)),
  );
  // When the user opens the add form with a history already filling (or
  // exceeding) the recommended lookback window, surface a heads-up that
  // further seasons won't influence schedule generation. Informational only —
  // doesn't block the add.
  const showLookbackNote =
    addingPastSeason &&
    editingSeasonIndex === null &&
    history.length >= recommendedLookbackTotal;

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
              Enter your Sleeper username, or paste your league ID from
              sleeper.com/leagues/<strong>YOUR_ID</strong>.
            </>
          ) : platform === "espn" ? (
            <>
              Enter your league ID from fantasy.espn.com/football/league?leagueId=
              <strong>YOUR_ID</strong> (public leagues only).
            </>
          ) : platform === "manual" ? (
            <>
              For leagues on platforms without automatic import. Enter your league
              info, then add past seasons manually in the next step.
            </>
          ) : (
            <>Sign in with Yahoo to import your fantasy leagues.</>
          )}
        </p>
        <div className="flex flex-wrap gap-2 items-stretch justify-center">
          <select
            className="w-full sm:w-auto bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 font-mono outline-none focus:border-slate-500"
            value={platform}
            onChange={(e) => {
              const next = e.target.value as ImportPlatform;
              if (next === platform) return;
              setPlatform(next);
              setLeagueId("");
              setManualLeagueName("");
              setManualTeamCount(12);
              setManualWeekCount(14);
              setImportPreview(null);
              setImportStatus("");
              setImportMsg("");
              setYahooLeagues(null);
              setSelectedYahooLeague("");
              setSleeperLeagues(null);
              setSelectedSleeperLeague("");
              if (next === "yahoo") {
                void fetchYahooLeagues();
              }
            }}
          >
            <option value="sleeper">Sleeper</option>
            <option value="espn">ESPN</option>
            <option value="yahoo">Yahoo</option>
            <option value="manual">Manual (NFL.com, CBS, other)</option>
          </select>
          {platform === "yahoo" ? (
            yahooLeagues && yahooLeagues.length > 1 ? (
              <>
                <select
                  className={cls.leagueInput}
                  value={selectedYahooLeague}
                  onChange={(e) => setSelectedYahooLeague(e.target.value)}
                >
                  <option value="">- pick a league -</option>
                  {yahooLeagues.map((l) => (
                    <option key={l.leagueKey} value={l.leagueKey}>
                      {l.season ? `${l.season} - ` : ""}
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
          ) : platform === "manual" ? (
            <>
              <input
                className={cls.leagueInput}
                value={manualLeagueName}
                onChange={(e) => setManualLeagueName(e.target.value)}
                placeholder="League name"
                maxLength={48}
              />
              <div className="basis-full h-0" aria-hidden="true" />
              <div className="flex gap-2 items-stretch w-full justify-center">
                <select
                  className="flex-1 sm:flex-none min-w-0 bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 font-mono outline-none focus:border-slate-500"
                  value={manualTeamCount}
                  onChange={(e) => setManualTeamCount(Number(e.target.value))}
                >
                  <option value={8}>8 teams</option>
                  <option value={10}>10 teams</option>
                  <option value={12}>12 teams</option>
                  <option value={14}>14 teams</option>
                </select>
                <select
                  className="flex-1 sm:flex-none min-w-0 bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 font-mono outline-none focus:border-slate-500"
                  value={manualWeekCount}
                  onChange={(e) => setManualWeekCount(Number(e.target.value))}
                >
                  <option value={13}>13 weeks</option>
                  <option value={14}>14 weeks</option>
                  <option value={15}>15 weeks</option>
                </select>
                <button
                  className={cls.primaryBtn}
                  onClick={handleManualStart}
                  disabled={!manualLeagueName.trim()}
                >
                  Start
                </button>
              </div>
            </>
          ) : platform === "sleeper" && sleeperLeagues && sleeperLeagues.length > 1 ? (
            <>
              <select
                className={cls.leagueInput}
                value={selectedSleeperLeague}
                onChange={(e) => setSelectedSleeperLeague(e.target.value)}
              >
                <option value="">- pick a league -</option>
                {sleeperLeagues.map((l) => (
                  <option key={l.leagueId} value={l.leagueId}>
                    {l.season ? `${l.season} - ` : ""}
                    {l.name}
                  </option>
                ))}
              </select>
              <div className="basis-full h-0" aria-hidden="true" />
              <button
                className={cls.primaryBtn}
                onClick={() => fetchSleeperLeagueSeasons(selectedSleeperLeague)}
                disabled={!selectedSleeperLeague || importBusy}
              >
                {importStatus === "loading" ? "Loading…" : "Use this league"}
              </button>
            </>
          ) : (
            <>
              <input
                className={cls.leagueInput}
                value={leagueId}
                onChange={(e) => {
                  setLeagueId(e.target.value);
                  if (importPreview) setImportPreview(null);
                  if (sleeperLeagues) {
                    setSleeperLeagues(null);
                    setSelectedSleeperLeague("");
                  }
                  if (importStatus) {
                    setImportStatus("");
                    setImportMsg("");
                  }
                }}
                placeholder={
                  platform === "sleeper"
                    ? "e.g. karimcozey or 1180738142470492160"
                    : "e.g. 123456789"
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

        {importStatus === "error" && importHelpUrl ? (
          <p className={`text-[11px] mt-2 ${statusToneClass(importStatus)}`}>
            This ESPN league is private. Temporarily make your league public (
            <a
              href={importHelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-300 underline hover:text-slate-200"
            >
              see instructions
            </a>
            ), then try again. Or, choose Manual entry to import without changing any ESPN settings.
          </p>
        ) : (
          importMsg && !importPreview && (
            <p className={`text-[11px] mt-2 text-center ${statusToneClass(importStatus)}`}>{importMsg}</p>
          )
        )}
      </div>

      {/* Shared import preview */}
      {importPreview &&
        (() => {
          const mostRecent = importPreview.seasons[0]!;
          const detected = detectFormatFromImport(mostRecent);
          if (!detected) return null;
          const leagueLabel = (mostRecent.seasonName || "").trim();
          const platformName = platformLabel(importPreview.platform);
          const formatLabel = `${detected.teamCount}-team / ${detected.weekCount}-week`;
          const seasonCount = importPreview.seasons.length;
          const years = importPreview.seasons
            .map((s) => s.seasonYear || "?")
            .join(", ");
          const sortedManagers = [...mostRecent.teamNames].sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
          );
          return (
            <div className="mt-2.5 mb-3 px-3 py-2.5 bg-slate-800 rounded-md border border-emerald-700">
              <p className="text-xs text-slate-200 mb-1">
                {leagueLabel ? (
                  <>
                    <strong className="text-emerald-400">{leagueLabel}</strong>
                    <span className="text-slate-500"> · </span>
                    {formatLabel}
                    <span className="text-slate-500"> · </span>
                    {platformName}
                  </>
                ) : (
                  <>
                    <strong className="text-emerald-400">{platformName}</strong>
                    <span className="text-slate-500"> · </span>
                    {formatLabel}
                  </>
                )}
              </p>
              <p className="text-[11px] text-slate-400 mb-2">
                {seasonCount} season{seasonCount > 1 ? "s" : ""}: {years}
              </p>
              <p className="text-[11px] text-slate-500 mb-2">
                Managers: {sortedManagers.join(", ")}
              </p>
              <div className="flex gap-2 flex-wrap items-center justify-center">
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
                  <span className="text-[10px] text-slate-500">
                    Keeps your custom names
                  </span>
                )}
              </div>
            </div>
          );
        })()}
    </>
  );

  return (
    <div className="min-h-screen px-4 py-6 text-slate-200 font-mono">
      <div className="text-center mb-7">
        <h1 className="text-xl sm:text-2xl font-extrabold text-emerald-50 uppercase tracking-tight">
          <Link href="/">DoubleCheck</Link>
        </h1>
        <p className="text-[11px] text-emerald-400 mt-1 tracking-wider">
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
            ["teams", "1. Import"],
            ["doubles", "2. Review"],
            ["schedule", "3. Schedule"],
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
          <div className="flex gap-3 mt-6 flex-wrap justify-center">
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
              <div className="mt-1 flex flex-wrap gap-2 items-center text-[11px]">
                <label htmlFor="lookback-override" className="text-slate-500">
                  Lookback:
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
                  <span className="text-red-400">
                    {effectiveLookback.hard} hard season{effectiveLookback.hard === 1 ? "" : "s"}
                  </span>
                  {effectiveLookback.soft > 0 && (
                    <>
                      {" + "}
                      <span className="text-amber-400">
                        {effectiveLookback.soft} soft season
                        {effectiveLookback.soft === 1 ? "" : "s"}
                      </span>
                    </>
                  )}
                </span>
              </div>
              {effectiveLookbackTotal !== recommendedLookbackTotal && (
                <p className="mt-1.5 text-[11px] text-slate-500">
                  Recommended:{" "}
                  <span className="text-amber-400">{recommendedLookbackTotal}</span>{" "}
                  for {teamCount}-team / {weekCount}-week
                </p>
              )}
            </div>
          )}

          {history.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
                Season History ({history.length} saved)
              </summary>
              {[...history].reverse().map((h, displayIdx) => {
                const si = history.length - 1 - displayIdx;
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
                    className="px-2 py-1.5 text-xs flex flex-wrap gap-2 items-center"
                  >
                    <strong className="text-slate-200">{h.season}</strong>
                    <span className={`text-[10px] ${tone}`}>{label}</span>
                    {h.format !== "userid" && (
                      <span className="ml-auto flex gap-1">
                        <button
                          type="button"
                          className="bg-transparent text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 border border-amber-700 hover:border-amber-600 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          onClick={() => handleStartEditSeason(si)}
                          disabled={addingPastSeason}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="bg-transparent text-[10px] text-red-400 hover:text-red-300 px-1.5 py-0.5 border border-red-700 hover:border-red-600 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          onClick={() => handleDeleteSeason(si)}
                          disabled={addingPastSeason}
                        >
                          Delete
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </details>
          )}

          {addingPastSeason ? (
            <div className={`${cls.subSection} mt-4`}>
              {showLookbackNote && (
                <p className="text-[11px] text-amber-400 mb-2">
                  Additional seasons beyond the lookback window won&apos;t affect schedule
                  generation.
                </p>
              )}
              <h3 className={cls.sectionTitle}>
                {editingSeasonIndex !== null ? "Edit Past Season" : "Add Past Season"}
              </h3>
              <p className={cls.hint}>
                {editingSeasonIndex !== null
                  ? "Adjust the doubled matchups for this season."
                  : "Select the season year and click each doubled matchup from that season's schedule."}
              </p>
              <div className="flex flex-wrap gap-2 items-center mb-3">
                <select
                  className="bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 font-mono outline-none focus:border-slate-500 disabled:opacity-60 disabled:cursor-not-allowed"
                  value={pastSeasonYear}
                  onChange={(e) => setPastSeasonYear(e.target.value)}
                  disabled={editingSeasonIndex !== null}
                >
                  {editingSeasonIndex !== null ? (
                    <option value={pastSeasonYear}>{pastSeasonYear}</option>
                  ) : (
                    availablePastSeasonYears.map((y) => (
                      <option key={y} value={String(y)}>
                        {y}
                      </option>
                    ))
                  )}
                </select>
                <span className="text-[10px] text-slate-500">
                  {pastSeasonDoubles.size} pair{pastSeasonDoubles.size === 1 ? "" : "s"} selected
                </span>
              </div>
              <div className="overflow-x-auto -mx-3.5 px-3.5">
                <div className="inline-block min-w-fit">
                  <div className="flex sticky top-0 z-20">
                    <div className="w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-semibold border border-slate-800 box-border sticky left-0 z-20" />
                    {teams.map((t, i) => (
                      <div
                        key={i}
                        onMouseEnter={(e) => showHeaderTooltip(t, e.currentTarget)}
                        onMouseLeave={hideHeaderTooltip}
                        className="w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-semibold border border-slate-800 box-border overflow-hidden whitespace-nowrap"
                      >
                        {abbrev(t)}
                      </div>
                    ))}
                  </div>
                  {teams.map((t, i) => (
                    <div key={i} className="flex">
                      <div
                        onMouseEnter={(e) => showHeaderTooltip(t, e.currentTarget)}
                        onMouseLeave={hideHeaderTooltip}
                        className="w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-semibold border border-slate-800 box-border sticky left-0 z-10 overflow-hidden whitespace-nowrap"
                      >
                        {abbrev(t)}
                      </div>
                      {teams.map((_, j) => {
                        if (j <= i) {
                          return (
                            <div
                              key={j}
                              className="w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 bg-slate-900 border border-slate-800 box-border"
                            />
                          );
                        }
                        const selected = pastSeasonDoubles.has(pairKey(i, j));
                        return (
                          <button
                            key={j}
                            type="button"
                            onClick={() => togglePastSeasonDouble(i, j)}
                            className={`w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 flex items-center justify-center text-[10px] border border-slate-800 box-border select-none cursor-pointer ${
                              selected
                                ? "bg-emerald-900 text-emerald-400 font-bold"
                                : "bg-slate-800 text-slate-500 hover:bg-slate-700"
                            }`}
                          >
                            {selected ? "✕" : ""}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex gap-2 mt-3 flex-wrap">
                <button
                  className={cls.primaryBtn}
                  onClick={handleApplyPastSeason}
                  disabled={!pastSeasonYear.trim()}
                >
                  {editingSeasonIndex !== null ? "Update Season" : "Add Season"}
                </button>
                <button className={cls.secondaryBtn} onClick={handleCancelPastSeason}>
                  Cancel
                </button>
              </div>
            </div>
          ) : availablePastSeasonYears.length > 0 ? (
            <div className="mt-4">
              <button
                className="bg-transparent text-emerald-400 border border-emerald-700 px-4 py-2.5 rounded-md text-[13px] cursor-pointer hover:border-emerald-600 hover:text-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleStartAddSeason}
              >
                + Add Past Season
              </button>
            </div>
          ) : null}

          {/* Matrix grid (horizontal scroll on mobile) */}
          <div className="overflow-x-auto -mx-2 px-2 mt-4">
            <div className="inline-block min-w-fit">
              <div className="flex sticky top-0 z-20">
                <div className="w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-semibold border border-slate-800 box-border sticky left-0 z-20" />
                {teams.map((t, i) => (
                  <div
                    key={i}
                    onMouseEnter={(e) => showHeaderTooltip(t, e.currentTarget)}
                    onMouseLeave={hideHeaderTooltip}
                    className="w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-semibold border border-slate-800 box-border overflow-hidden whitespace-nowrap"
                  >
                    {abbrev(t)}
                  </div>
                ))}
              </div>
              {teams.map((t, i) => (
                <div key={i} className="flex">
                  <div
                    onMouseEnter={(e) => showHeaderTooltip(t, e.currentTarget)}
                    onMouseLeave={hideHeaderTooltip}
                    className="w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-semibold border border-slate-800 box-border sticky left-0 z-10 overflow-hidden whitespace-nowrap"
                  >
                    {abbrev(t)}
                  </div>
                  {teams.map((_, j) => {
                    if (j <= i) {
                      return (
                        <div
                          key={j}
                          className="w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 bg-slate-900 border border-slate-800 box-border"
                        />
                      );
                    }
                    const at = cellAvoidType(i, j);
                    const isManual = manualDoubles.has(pairKey(i, j));
                    const isLocked = at === "hard" || at === "soft";
                    let cellTone = "bg-slate-800 text-slate-500 hover:bg-slate-700";
                    let glyph = "";
                    if (isManual) {
                      cellTone = "bg-purple-900 text-purple-400 font-bold";
                      glyph = "✕";
                    } else if (at === "hard") {
                      cellTone = "bg-red-950 text-red-400 font-bold";
                      glyph = "H";
                    } else if (at === "soft") {
                      cellTone = "bg-amber-900 text-amber-400 font-semibold";
                      glyph = "S";
                    }
                    const cellDisabled = isLocked || addingPastSeason;
                    return (
                      <button
                        key={j}
                        type="button"
                        onClick={() => toggleDouble(i, j)}
                        disabled={cellDisabled}
                        className={`w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 flex items-center justify-center text-[10px] border border-slate-800 box-border select-none ${cellDisabled ? "cursor-not-allowed" : "cursor-pointer"} ${cellTone}`}
                      >
                        {glyph}
                      </button>
                    );
                  })}
                </div>
              ))}
              {manualDoubles.size > 0 && (
                <div className="flex">
                  <div className="w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-semibold border border-slate-800 box-border sticky left-0 z-10">
                    CT
                  </div>
                  {doublesPerTeam().map((c, i) => (
                    <div
                      key={i}
                      className={`w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 flex items-center justify-center bg-slate-900 text-[8px] font-semibold border border-slate-800 box-border ${
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
            <span className="text-purple-400">✕</span> manual avoid{"  "}
            <span className="text-red-400">H</span> hard avoid (last {effectiveLookback.hard}{" "}
            season{effectiveLookback.hard !== 1 ? "s" : ""}){"  "}
            <span className="text-amber-400">S</span> soft avoid (older)
          </p>

          {manualDoubles.size > 0 && (
            <div className="mt-3">
              <button
                className="bg-transparent text-amber-400 border border-amber-700 px-4 py-2.5 rounded-md text-[13px] cursor-pointer hover:text-amber-300 hover:border-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => setManualDoubles(new Set())}
                disabled={addingPastSeason}
              >
                Clear Manual Overrides
              </button>
            </div>
          )}

          {/* Mobile-friendly per-team summary */}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
              Avoidance by team
            </summary>
            <div className="mt-2 flex flex-col gap-1">
              {[...teams.entries()]
                .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }))
                .map(([i, t]) => {
                const partners: { name: string; tone: string; sortKey: number }[] = [];
                for (let j = 0; j < teamCount; j++) {
                  if (j === i) continue;
                  const at = cellAvoidType(i, j);
                  const isManual = manualDoubles.has(pairKey(i, j));
                  if (isManual) {
                    partners.push({ name: teams[j]!, tone: "text-purple-400", sortKey: 0 });
                  } else if (at === "hard") {
                    partners.push({ name: teams[j]!, tone: "text-red-400", sortKey: 1 });
                  } else if (at === "soft") {
                    partners.push({ name: teams[j]!, tone: "text-amber-400", sortKey: 2 });
                  }
                }
                if (partners.length === 0) return null;
                partners.sort(
                  (a, b) => a.sortKey - b.sortKey || a.name.localeCompare(b.name),
                );
                return (
                  <div key={i} className="text-xs px-2 py-1 bg-slate-900 rounded">
                    <div className="text-slate-200 font-semibold">{t}</div>
                    <div>
                      {partners.map((p, k) => (
                        <span key={k}>
                          {k > 0 ? ", " : ""}
                          <span className={p.tone}>{p.name}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </details>

          {(() => {
            // Derive valid team indices. safeB is forced to differ from safeA
            // so the dropdown can never silently render an invalid same-team
            // pair; the Team B option matching safeA is also explicitly disabled.
            const safeA = pinTeamA < teamCount ? pinTeamA : 0;
            const safeBCandidate =
              pinTeamB < teamCount ? pinTeamB : Math.min(1, Math.max(0, teamCount - 1));
            const safeB =
              safeBCandidate === safeA ? (safeA === 0 ? Math.min(1, teamCount - 1) : 0) : safeBCandidate;
            const pinAKey = pairKey(safeA, safeB);
            const sameTeam = safeA === safeB;
            const maxPinsPerPair = Math.max(
              1,
              Math.ceil(weekCount / Math.max(1, teamCount - 1)),
            );
            const existingPinsForPair = rivalryPins.filter(
              (p) => pairKey(p.teamA, p.teamB) === pinAKey,
            ).length;
            const pairAtMax = existingPinsForPair >= maxPinsPerPair;

            // In dp=1 formats (e.g. 14/14) each team has exactly one doubled
            // partner, so a 2-pin pair MUST sit at natural-partner weeks (W
            // and W ± separation). If the pair already has one specific-week
            // pin, the only valid second-pin week is that partner — every
            // other week would force a structurally infeasible non-partner
            // double.
            const partnerOnlyWeek: number | null = (() => {
              if (!format || format.doublesPerTeam !== 1) return null;
              if (existingPinsForPair !== 1) return null;
              const existing = rivalryPins.find(
                (p) => pairKey(p.teamA, p.teamB) === pinAKey,
              );
              if (!existing || existing.week === null) return null;
              const sep = format.separation;
              const up = existing.week + sep;
              const down = existing.week - sep;
              if (up >= 1 && up <= weekCount) return up;
              if (down >= 1 && down <= weekCount) return down;
              return null;
            })();

            // When the pair's existing pin sits on a week whose natural
            // partner (W ± separation) falls outside [1, weekCount], the
            // second specific-week pin has no in-range partner — any
            // specific week the user picks creates a non-partner double
            // that the algorithm rejects at generation time. Block adding
            // a second specific-week pin in this state; "Any" still lets
            // the algorithm route the rematch.
            const existingPinForPair =
              existingPinsForPair === 1
                ? rivalryPins.find((p) => pairKey(p.teamA, p.teamB) === pinAKey) ??
                  null
                : null;
            const noPartnerWeekForPair: boolean =
              !!format &&
              format.doublesPerTeam === 1 &&
              !!existingPinForPair &&
              existingPinForPair.week !== null &&
              existingPinForPair.week + format.separation > weekCount &&
              existingPinForPair.week - format.separation < 1;

            // Per-week option state. Order matters: an exact-pair duplicate
            // takes priority over the generic team-conflict label.
            const weekOptionState = (W: number): { disabled: boolean; suffix: string } => {
              const exactDup = rivalryPins.some(
                (p) => p.week === W && pairKey(p.teamA, p.teamB) === pinAKey,
              );
              if (exactDup) return { disabled: true, suffix: " (already pinned)" };
              const teamConflict = rivalryPins.some(
                (p) =>
                  p.week === W &&
                  (p.teamA === safeA ||
                    p.teamB === safeA ||
                    p.teamA === safeB ||
                    p.teamB === safeB),
              );
              if (teamConflict) return { disabled: true, suffix: " (pinned)" };
              if (noPartnerWeekForPair) {
                return { disabled: true, suffix: " (unavailable)" };
              }
              if (partnerOnlyWeek !== null && W !== partnerOnlyWeek) {
                return { disabled: true, suffix: " (unavailable)" };
              }
              return { disabled: false, suffix: "" };
            };

            const pinWeekDisabled =
              pinWeek === null ? pairAtMax : weekOptionState(pinWeek).disabled;

            // Fallback inline validation. The smart disabling above prevents
            // most invalid selections from being made; this catches stale
            // state (e.g., a week selected before the teams were changed).
            let pinError = "";
            if (sameTeam) {
              pinError = "Pick two different teams.";
            }
            // Same team, same week (different opponent). Stricter and more
            // informative than the per-week conflict loop below, which still
            // runs as a fallback.
            if (!pinError && pinWeek !== null) {
              for (const p of rivalryPins) {
                if (p.week !== pinWeek) continue;
                if (pairKey(p.teamA, p.teamB) === pinAKey) continue;
                let conflictedIdx = -1;
                let opponentIdx = -1;
                if (p.teamA === safeA || p.teamB === safeA) {
                  conflictedIdx = safeA;
                  opponentIdx = p.teamA === safeA ? p.teamB : p.teamA;
                } else if (p.teamA === safeB || p.teamB === safeB) {
                  conflictedIdx = safeB;
                  opponentIdx = p.teamA === safeB ? p.teamB : p.teamA;
                }
                if (conflictedIdx >= 0) {
                  pinError =
                    `Team ${teams[conflictedIdx]} is already pinned to Week ${pinWeek} against ${teams[opponentIdx]}. ` +
                    "A team can only play once per week.";
                  break;
                }
              }
            }
            // Too many doubles for one team. Counts distinct pinned opponents
            // per team across all pins (including "Any"). A second pin for the
            // same pair doesn't add a new opponent, so it's allowed.
            if (!pinError && format) {
              const opponentsOf = (team: number) => {
                const set = new Set<number>();
                for (const p of rivalryPins) {
                  if (p.teamA === team) set.add(p.teamB);
                  else if (p.teamB === team) set.add(p.teamA);
                }
                return set;
              };
              const maxDoubles = format.doublesPerTeam;
              const oppA = opponentsOf(safeA);
              if (!oppA.has(safeB) && oppA.size >= maxDoubles) {
                pinError = `${teams[safeA]} is already pinned against ${oppA.size} different opponents — this format supports at most ${maxDoubles} repeat opponents per team.`;
              } else {
                const oppB = opponentsOf(safeB);
                if (!oppB.has(safeA) && oppB.size >= maxDoubles) {
                  pinError = `${teams[safeB]} is already pinned against ${oppB.size} different opponents — this format supports at most ${maxDoubles} repeat opponents per team.`;
                }
              }
            }
            // Too many matchups in one week. A full week is teamCount / 2.
            if (!pinError && pinWeek !== null) {
              const matchupsInWeek = rivalryPins.filter(
                (p) => p.week === pinWeek,
              ).length;
              const fullWeek = Math.floor(teamCount / 2);
              if (matchupsInWeek >= fullWeek) {
                pinError = `Week ${pinWeek} already has ${matchupsInWeek} matchups pinned — that fills the entire week.`;
              }
            }
            if (!pinError && pairAtMax) {
              pinError = `This pair can play at most ${maxPinsPerPair} time${
                maxPinsPerPair === 1 ? "" : "s"
              } in this format.`;
            }
            if (
              !pinError &&
              pinWeek !== null &&
              (noPartnerWeekForPair ||
                (partnerOnlyWeek !== null && pinWeek !== partnerOnlyWeek))
            ) {
              pinError =
                partnerOnlyWeek !== null
                  ? `This format only allows the rematch in Week ${partnerOnlyWeek}. ` +
                    "Use 'Any' to let the algorithm place it automatically."
                  : "No valid week available for a second pin in this format. " +
                    "Use 'Any' to let the algorithm place the rematch.";
            }
            if (!pinError && pinWeek !== null) {
              for (const p of rivalryPins) {
                if (p.week !== pinWeek) continue;
                const conflictA = p.teamA === safeA || p.teamB === safeA;
                const conflictB = p.teamA === safeB || p.teamB === safeB;
                if (conflictA || conflictB) {
                  const conflictedIdx = conflictA ? safeA : safeB;
                  pinError = `${teams[conflictedIdx]} is already pinned to Week ${pinWeek}.`;
                  break;
                }
              }
              if (!pinError) {
                const dupExists = rivalryPins.some(
                  (p) => p.week === pinWeek && pairKey(p.teamA, p.teamB) === pinAKey,
                );
                if (dupExists) pinError = "This matchup is already pinned to this week.";
              }
            }
            // Avoid warning is informational about the current selection; it
            // stays visible whenever the pair is avoided, regardless of any
            // active pinError or the post-add suppression flag.
            let avoidWarning = "";
            {
              const { hard, soft } = getAvoidSets();
              if (hard.has(pinAKey)) {
                avoidWarning =
                  "This pair is hard-avoided. This pin forces one game between them - they won't play again.";
              } else if (soft.has(pinAKey)) {
                avoidWarning =
                  "This pair is soft-avoided. This pin forces one game between them.";
              }
            }
            const addDisabled = !!pinError || addingPastSeason || pinWeekDisabled;
            return (
              <div className={`${cls.subSection} mt-4`}>
                <h3 className={cls.sectionTitle}>Rivalry Weeks</h3>
                <p className={cls.hint}>
                  Pick two teams and a week to lock in a matchup. Pins show in blue.
                </p>
                <div className="flex flex-wrap gap-2 items-stretch">
                  <select
                    aria-label="Week"
                    className="w-full sm:w-auto bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 font-mono outline-none focus:border-slate-500"
                    value={pinWeek === null ? "any" : String(pinWeek)}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPinWeek(v === "any" ? null : parseInt(v, 10));
                      setPinJustAdded(false);
                    }}
                  >
                    <option value="any" disabled={pairAtMax}>
                      Any week
                    </option>
                    {Array.from({ length: weekCount }, (_, i) => {
                      const W = i + 1;
                      const { disabled, suffix } = weekOptionState(W);
                      return (
                        <option key={W} value={String(W)} disabled={disabled}>
                          Week {W}
                          {suffix}
                        </option>
                      );
                    })}
                  </select>
                  <select
                    aria-label="First team"
                    className="w-[calc(50%-0.25rem)] sm:w-auto sm:flex-1 sm:min-w-[8rem] bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 font-mono outline-none focus:border-slate-500"
                    value={safeA}
                    onChange={(e) => {
                      const newA = Number(e.target.value);
                      setPinTeamA(newA);
                      // Auto-shift Team B if it would collide with the new A.
                      if (pinTeamB === newA) {
                        setPinTeamB(newA === 0 ? Math.min(1, teamCount - 1) : 0);
                      }
                      setPinJustAdded(false);
                    }}
                  >
                    {teams.map((t, i) => (
                      <option key={i} value={i}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Second team"
                    className="w-[calc(50%-0.25rem)] sm:w-auto sm:flex-1 sm:min-w-[8rem] bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 font-mono outline-none focus:border-slate-500"
                    value={safeB}
                    onChange={(e) => {
                      const newB = Number(e.target.value);
                      if (newB !== safeA) setPinTeamB(newB);
                      setPinJustAdded(false);
                    }}
                  >
                    {teams.map((t, i) => (
                      <option key={i} value={i} disabled={i === safeA}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="bg-sky-500 text-sky-50 border-0 px-5 py-2.5 rounded-md text-[13px] font-semibold cursor-pointer hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
                    disabled={addDisabled}
                    onClick={() => {
                      if (addDisabled) return;
                      const nextPins = [
                        ...rivalryPins,
                        { teamA: safeA, teamB: safeB, week: pinWeek },
                      ];
                      setRivalryPins(nextPins);
                      // Keep the week and advance both team defaults so the
                      // next pin can fit without manual fiddling. Team A is
                      // the lowest team still free in the kept week; Team B
                      // is the lowest free team after that. Falls back to
                      // 0 and 1 if no free teams remain that week.
                      const isBusyInWeek = (t: number): boolean => {
                        if (pinWeek === null) return false;
                        return nextPins.some(
                          (p) =>
                            p.week === pinWeek &&
                            (p.teamA === t || p.teamB === t),
                        );
                      };
                      let nextA = 0;
                      for (let i = 0; i < teamCount; i++) {
                        if (!isBusyInWeek(i)) {
                          nextA = i;
                          break;
                        }
                      }
                      let nextB = nextA === 0 ? 1 : 0;
                      for (let i = nextA + 1; i < teamCount; i++) {
                        if (!isBusyInWeek(i)) {
                          nextB = i;
                          break;
                        }
                      }
                      setPinTeamA(nextA);
                      setPinTeamB(nextB);
                      setPinJustAdded(true);
                    }}
                  >
                    Pin
                  </button>
                </div>
                {!pinJustAdded && pinError ? (
                  <p className="text-[11px] mt-2 text-red-400">{pinError}</p>
                ) : avoidWarning ? (
                  <p className="text-[11px] mt-2 text-amber-400">{avoidWarning}</p>
                ) : null}
                {rivalryPins.length > 0 && (
                  <>
                    <div className="mt-3 flex flex-col gap-1">
                      {rivalryPins.map((p, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 px-2 py-1 bg-slate-800 rounded text-xs border border-slate-700"
                        >
                          <span className="flex-1 text-slate-200">
                            <span className="text-sky-400">{teams[p.teamA]}</span>
                            <span className="text-slate-500"> vs </span>
                            <span className="text-sky-400">{teams[p.teamB]}</span>
                            <span className="text-slate-500">
                              {" — "}
                              {p.week === null ? "Any week" : `Week ${p.week}`}
                            </span>
                          </span>
                          <button
                            type="button"
                            className="bg-transparent text-[10px] text-red-400 hover:text-red-300 px-1.5 py-0.5 border border-red-700 hover:border-red-600 rounded cursor-pointer"
                            onClick={() =>
                              setRivalryPins(rivalryPins.filter((_, i) => i !== idx))
                            }
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3">
                      <button
                        type="button"
                        className="bg-transparent text-amber-400 border border-amber-700 px-4 py-2.5 rounded-md text-[13px] cursor-pointer hover:text-amber-300 hover:border-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={() => setRivalryPins([])}
                        disabled={addingPastSeason}
                      >
                        Clear Rivalry Pins
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          <div className="flex gap-3 mt-5 flex-wrap justify-center">
            <button
              className={cls.primaryBtn}
              onClick={handleGenerate}
              disabled={addingPastSeason}
            >
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
            {leagueName ? `${leagueName} ${scheduleYear} Schedule` : "Generated Schedule"}
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

          {(() => {
            // Keyed by `${pairKey}@${week}` so we can ask "is this specific
            // pair-week appearance pinned?" — naturally-doubled second weeks
            // are NOT in this map and so render red, not blue.
            const placementByWeekPair = new Map<string, RivalryPlacement>();
            for (const p of schedule.rivalryPlacements) {
              placementByWeekPair.set(
                `${pairKey(p.teamA, p.teamB)}@${p.placedWeek}`,
                p,
              );
            }
            const hasRivalries = schedule.rivalryPlacements.length > 0;
            const summaryTitle = hasRivalries ? "Rival & Double Matchups" : "Double Matchups";
            return (
              <>
                <div className="bg-slate-900 border border-slate-700 rounded-lg p-4">
                  <h3 className="text-sm font-bold text-emerald-50 mb-3 text-center">
                    Week {selectedWeek + 1}
                  </h3>
                  <div className="flex flex-col gap-2">
                    {schedule.weeks[selectedWeek]!.map(
                      ([a, b]: [number, number], gi: number) => {
                        const key = pairKey(a, b);
                        const isDouble = schedule.doubledPairs.has(key);
                        const isPinnedHere = placementByWeekPair.has(
                          `${key}@${selectedWeek + 1}`,
                        );
                        const isRepeat = schedule.hardRepeated.includes(key);
                        const vsTone = isPinnedHere
                          ? "text-sky-400"
                          : isDouble
                            ? "text-red-400"
                            : "text-emerald-400";
                        return (
                          <div
                            key={gi}
                            className="flex items-center gap-2.5 px-2.5 py-1.5 bg-slate-800 rounded-md border border-slate-700"
                          >
                            <span className="flex-1 text-[13px] text-slate-200 text-center">
                              {teams[a]}
                            </span>
                            <span className={`text-[11px] font-bold ${vsTone}`}>vs</span>
                            <span className="flex-1 text-[13px] text-slate-200 text-center">
                              {teams[b]}
                            </span>
                            {isRepeat && (
                              <span className="text-amber-400 text-sm ml-1">★</span>
                            )}
                          </div>
                        );
                      },
                    )}
                  </div>
                </div>

                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
                    {summaryTitle}
                  </summary>
                  <div className="flex flex-col gap-1 mt-2">
                    {[...teams.entries()]
                      .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }))
                      .map(([i, t]) => {
                      type Appearance = { week: number; isPinned: boolean };
                      type Entry = {
                        opponentIdx: number;
                        name: string;
                        appearances: Appearance[];
                        anyPinned: boolean;
                      };
                      // Collect all appearances for team i, grouped by opponent.
                      const byOpponent = new Map<number, Appearance[]>();
                      schedule.weeks.forEach((week, wi) => {
                        const W = wi + 1;
                        for (const [a, b] of week) {
                          const key = pairKey(a, b);
                          const isDouble = schedule.doubledPairs.has(key);
                          const isPinned = placementByWeekPair.has(`${key}@${W}`);
                          if (!isDouble && !isPinned) continue;
                          const other = a === i ? b : b === i ? a : null;
                          if (other === null) continue;
                          let list = byOpponent.get(other);
                          if (!list) {
                            list = [];
                            byOpponent.set(other, list);
                          }
                          list.push({ week: W, isPinned });
                        }
                      });
                      if (byOpponent.size === 0) return null;
                      const entries: Entry[] = [];
                      byOpponent.forEach((apps, opp) => {
                        apps.sort((x, y) => x.week - y.week);
                        entries.push({
                          opponentIdx: opp,
                          name: teams[opp]!,
                          appearances: apps,
                          anyPinned: apps.some((a) => a.isPinned),
                        });
                      });
                      // Pinned-rivalry entries first, then alphabetical by name.
                      entries.sort(
                        (x, y) =>
                          (x.anyPinned ? 0 : 1) - (y.anyPinned ? 0 : 1) ||
                          x.name.localeCompare(y.name),
                      );
                      return (
                        <div key={i} className="text-xs px-2 py-1 bg-slate-900 rounded">
                          <div className="text-slate-200 font-semibold">{t}</div>
                          <div className="text-slate-500">
                            {entries.map((e, k) => (
                              <span key={k}>
                                {k > 0 ? ", " : ""}
                                <span
                                  className={
                                    e.anyPinned ? "text-sky-400" : "text-red-400"
                                  }
                                >
                                  {e.name}
                                </span>
                                {" ("}
                                {e.appearances.map((app, j) => (
                                  <span key={j}>
                                    {j > 0 ? ", " : ""}
                                    <span
                                      className={
                                        app.isPinned ? "text-sky-400" : "text-red-400"
                                      }
                                    >
                                      Week {app.week}
                                    </span>
                                  </span>
                                ))}
                                {")"}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              </>
            );
          })()}

          <div className="flex gap-3 mt-6 flex-wrap items-center justify-center">
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
                ✓ Saved - share link ready
              </span>
            )}
          </div>

          {shareStatus === "ready" && shareUrl && (
            <div className="mt-3 px-3 py-2.5 bg-slate-900 rounded-md border border-emerald-700">
              <p className="text-[11px] text-slate-400 mb-2">
                Shareable read-only link (expires in 365 days):
              </p>
              <div className="flex gap-2 items-center flex-wrap justify-center">
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

          <p className="text-[11px] text-slate-300 mt-4 text-center">
            {platform === "sleeper" ? (
              <>
                To apply this schedule, edit your matchups in Sleeper&apos;s League Settings (
                <a
                  href="https://support.sleeper.com/en/articles/1955931-can-i-randomize-my-league-s-schedule"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-300 underline hover:text-slate-200"
                >
                  see instructions
                </a>
                ).
              </>
            ) : platform === "espn" ? (
              <>
                To apply this schedule, go to LM Tools &gt; Edit Head-to-Head Schedule and update
                each week&apos;s matchups (
                <a
                  href="https://support.espn.com/hc/en-us/articles/115003914792-Change-League-Schedule-and-or-Head-to-Head-Matchups-LM-Leagues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-300 underline hover:text-slate-200"
                >
                  see instructions
                </a>
                ).
              </>
            ) : platform === "yahoo" ? (
              <>
                To apply this schedule, go to Commissioner &gt; Schedules &amp; Playoffs &gt; Edit
                Schedules and update each week&apos;s matchups (
                <a
                  href="https://help.yahoo.com/kb/edit-season-schedules-head-to-head-leagues-sln6320.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-300 underline hover:text-slate-200"
                >
                  see instructions
                </a>
                ).
              </>
            ) : (
              <>To apply this schedule, enter these matchups in your league settings.</>
            )}
          </p>

          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
              Copy Full Schedule as Text
            </summary>
            <textarea
              readOnly
              className="w-full bg-slate-900 text-slate-400 border border-slate-700 rounded-md p-2.5 text-[11px] font-mono resize-y mt-2 box-border"
              value={
                (leagueName ? `${leagueName} ${scheduleYear} Schedule\n\n` : "") +
                schedule.weeks
                  .map(
                    (week: Matching, wi: number) =>
                      `Week ${wi + 1}\n` +
                      week
                        .map(([a, b]: [number, number]) =>
                          teams[a]!.localeCompare(teams[b]!, undefined, {
                            numeric: true,
                          }) <= 0
                            ? `  ${teams[a]}  vs  ${teams[b]}`
                            : `  ${teams[b]}  vs  ${teams[a]}`,
                        )
                        .sort((x, y) =>
                          x.localeCompare(y, undefined, { numeric: true }),
                        )
                        .join("\n"),
                  )
                  .join("\n\n")
              }
              rows={12}
              onClick={(e: MouseEvent<HTMLTextAreaElement>) =>
                (e.target as HTMLTextAreaElement).select()
              }
            />
          </details>
        </div>
      )}

        </>
      )}

      {selectedFormat && (
        <div className="max-w-[700px] mx-auto mt-6 text-center">
          {!confirmReset ? (
            <div className="inline-flex gap-2 items-center justify-center flex-wrap">
              <button
                className="bg-transparent text-amber-400 border border-amber-700 px-3 py-1.5 rounded-md text-[11px] cursor-pointer hover:text-amber-300 hover:border-amber-600"
                onClick={() => {
                  if (step === "teams") {
                    setSelectedFormat(null);
                    setStep("teams");
                    setFurthestStep("teams");
                  } else {
                    setStep(step === "schedule" ? "doubles" : "teams");
                  }
                }}
              >
                ← Back
              </button>
              <button
                className="bg-transparent text-red-400 border border-red-700 px-3 py-1.5 rounded-md text-[11px] cursor-pointer hover:text-red-300 hover:border-red-600"
                onClick={() => setConfirmReset(true)}
              >
                Reset
              </button>
            </div>
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

      {tooltipInfo && (
        <div
          className="fixed z-50 bg-slate-700 text-slate-200 text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap pointer-events-none"
          style={{
            top: tooltipInfo.rect.top - 4,
            left: tooltipInfo.rect.left + tooltipInfo.rect.width / 2,
            transform: "translate(-50%, -100%)",
          }}
        >
          {tooltipInfo.text}
        </div>
      )}
    </div>
  );
}
