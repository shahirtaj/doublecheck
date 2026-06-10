"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import Link from "next/link";
import {
  buildAvoidMap,
  buildSchedule,
  describeFormat,
  type LookbackWindow,
  type RivalryPin,
} from "@/lib/algorithm";
import { STEP_ORDER, STORAGE_KEY } from "./components/constants";
import type { ImportPlatform, ImportSource, Step } from "./components/types";
import {
  computeDisplayWeeks,
  deriveLookback,
  normalizeHistory,
  priorSeasons,
  yahooOAuthReturnPatch,
} from "./components/utils";
import { cls } from "./components/styles";
import {
  initialState,
  reducer,
  type SaveToStorageExtra,
  type State,
} from "./components/state";
import { ImportSections, StepImport } from "./components/StepImport";
import { StepReview } from "./components/StepReview";
import { StepSchedule } from "./components/StepSchedule";
import { Footer } from "./components/Footer";

// ── Component ─────────────────────────────────────────────

export default function GeneratePage() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const {
    step,
    furthestStep,
    selectedFormat,
    teams,
    userIds,
    leagueName,
    manualDoubles,
    rivalryPins,
    history,
    lookbackOverride,
    loading,
    confirmReset,
    platform,
    importSource,
    tooltipInfo,
  } = state;

  const patch = useCallback(
    (p: Partial<State>) => dispatch({ type: "patch", patch: p }),
    [],
  );
  const resetState = useCallback(() => dispatch({ type: "reset" }), []);

  // Per-field setter callbacks. They wrap `patch` so existing call sites read
  // like the old useState API; the underlying state lives in the single
  // useReducer above.
  const setStep = useCallback((v: Step) => patch({ step: v }), [patch]);
  const setConfirmReset = useCallback(
    (v: boolean) => patch({ confirmReset: v }),
    [patch],
  );

  const teamCount = selectedFormat?.teamCount ?? 0;
  const weekCount = selectedFormat?.weekCount ?? 0;
  const format = useMemo(
    () => (selectedFormat ? describeFormat(teamCount, weekCount) : null),
    [selectedFormat, teamCount, weekCount],
  );
  const isEdgeCaseFormat =
    !!format &&
    (format.variant === "pure-round-robin" ||
      format.variant === "complete-double-round-robin");
  // Edge-case card opener. Imports read "Detected an 8-team / 14-week
  // format: …" (the shape was inferred from league data); manual import reads
  // the declarative "An 8-team / 14-week format is …" - nothing was
  // detected, the user chose it. "format", not "league": the shape is
  // what's being described, the league is the named thing that has it.
  // Among even team counts only 8 and 18 take "an".
  const formatArticle = teamCount === 8 || teamCount === 18 ? "an" : "a";
  const edgeCaseOpener = (
    <>
      {platform === "manual"
        ? formatArticle === "an"
          ? "An"
          : "A"
        : `Detected ${formatArticle}`}{" "}
      <strong className="text-slate-200">
        {teamCount}-team / {weekCount}-week
      </strong>{" "}
      format{platform === "manual" ? " is " : ": "}
    </>
  );

  // Mirror `platform` and `importSource` so in-flight import fetches can
  // detect when the user has switched platforms or sources mid-request and
  // bail out instead of stomping on the new selection's state. Both refs are
  // needed: switching to "Restore from link" intentionally leaves `platform`
  // unchanged, so a platform check alone wouldn't catch it.
  const platformRef = useRef<ImportPlatform>("sleeper");
  useEffect(() => {
    platformRef.current = platform;
  }, [platform]);
  const importSourceRef = useRef<ImportSource>("sleeper");
  useEffect(() => {
    importSourceRef.current = importSource;
  }, [importSource]);
  // Monotonic counter for import requests. Each fetch helper claims the next
  // value at entry and the import dropdown bumps it on every switch, so
  // stale() can detect supersession that the value-equality platform/source
  // checks can't: an A-B-A dropdown round trip (sleeper -> espn -> sleeper)
  // lands the refs back on their original values, and a second fetch on the
  // SAME platform (a typo'd league ID refetched) never changes them at all -
  // either way a slow first response would land last and win.
  const importSeqRef = useRef(0);

  // Header tooltip: rendered as a fixed-position div at the root of the
  // return so it escapes the matrix's overflow containers. The hovered
  // cell's bounding rect drives positioning; a 200ms delay before showing
  // matches the prior CSS tooltip behavior.
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    };
  }, []);
  const showHeaderTooltip = useCallback(
    (text: string, target: HTMLElement) => {
      const rect = target.getBoundingClientRect();
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = setTimeout(() => {
        patch({ tooltipInfo: { text, rect } });
      }, 200);
    },
    [patch],
  );
  const hideHeaderTooltip = useCallback(() => {
    if (tooltipTimerRef.current) {
      clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
    patch({ tooltipInfo: null });
  }, [patch]);

  // Touch devices fire mouseenter briefly on tap, which would flash the
  // crosshair every time a cell toggles - meaningless and noisy. Only attach
  // the matrix hover handlers on devices with a precise pointer.
  useEffect(() => {
    const mq = window.matchMedia("(hover: hover)");
    patch({ canHover: mq.matches });
    const handler = (e: MediaQueryListEvent) => patch({ canHover: e.matches });
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [patch]);

  // Hydrate from localStorage on mount, folding in the Yahoo OAuth callback
  // hand-off (the callback route redirects to /?yahoo=connected on success or
  // /?yahoo=error&reason=... on failure; yahooOAuthReturnPatch switches to
  // the Yahoo platform and either flags the auto-load or surfaces the error
  // message). The two must land together: the OAuth return needs the import
  // UI on screen - ImportSections owns the pendingYahooConnect bridge and
  // renders the error message - so when storage would restore a format we
  // stash it in priorFormat instead of mounting the steps UI over the
  // hand-off. Teams/history still hydrate, so the auto-loaded Yahoo
  // re-import merges like any post-Back re-import.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let oauthPatch: Partial<State> | null = null;
    if (params.get("yahoo")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("yahoo");
      url.searchParams.delete("reason");
      window.history.replaceState({}, "", url.toString());
      oauthPatch = yahooOAuthReturnPatch(params);
    }

    let hydration: Partial<State> = {};
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        let storedTeamCount = 0;
        // Range-checked, not just type-checked: an out-of-range stored
        // format (e.g. 8 teams / 15 weeks from a legacy payload) would
        // misrender as an edge-case card or fail generation - better to
        // fall back to a fresh start than restore an unschedulable shape.
        if (
          d.format &&
          typeof d.format.teamCount === "number" &&
          typeof d.format.weekCount === "number" &&
          d.format.teamCount >= 2 &&
          d.format.teamCount % 2 === 0 &&
          d.format.weekCount >= d.format.teamCount - 1 &&
          d.format.weekCount <= 2 * (d.format.teamCount - 1)
        ) {
          hydration.selectedFormat = {
            teamCount: d.format.teamCount,
            weekCount: d.format.weekCount,
          };
          storedTeamCount = d.format.teamCount;
        }
        if (storedTeamCount > 0) {
          if (Array.isArray(d.teams) && d.teams.length === storedTeamCount)
            hydration.teams = d.teams;
          if (Array.isArray(d.userIds) && d.userIds.length === storedTeamCount)
            hydration.userIds = d.userIds;
          // normalizeHistory self-heals payloads saved before the import
          // merge deduped by year: duplicate-year rows collapse (last one
          // wins) and the rows come back in chronological order.
          if (Array.isArray(d.history))
            hydration.history = normalizeHistory(d.history);
          if (Array.isArray(d.manualDoubles))
            hydration.manualDoubles = new Set(d.manualDoubles);
          // Rivalry pins round-trip safely: team indices are assigned once
          // at import and the persisted teams restore index-identically.
          // Entries get the share validator's bounds treatment - malformed
          // ones are dropped instead of reaching the pin builder. Older
          // payloads lack the field; the [] default stands for those.
          // Gated on teams having hydrated too: a payload whose teams failed
          // their own length check would leave pins pointing into an empty
          // roster, and the pin list's name sort indexes teams directly.
          if (Array.isArray(d.rivalryPins) && hydration.teams) {
            const storedWeekCount = d.format.weekCount as number;
            hydration.rivalryPins = d.rivalryPins.filter(
              (p: unknown): p is RivalryPin => {
                if (!p || typeof p !== "object") return false;
                const pin = p as Record<string, unknown>;
                return (
                  typeof pin.teamA === "number" &&
                  Number.isInteger(pin.teamA) &&
                  typeof pin.teamB === "number" &&
                  Number.isInteger(pin.teamB) &&
                  pin.teamA >= 0 &&
                  pin.teamA < storedTeamCount &&
                  pin.teamB >= 0 &&
                  pin.teamB < storedTeamCount &&
                  pin.teamA !== pin.teamB &&
                  (pin.week === null ||
                    (typeof pin.week === "number" &&
                      Number.isInteger(pin.week) &&
                      pin.week >= 1 &&
                      pin.week <= storedWeekCount))
                );
              },
            );
          }
          if (typeof d.lookbackOverride === "number")
            hydration.lookbackOverride = d.lookbackOverride;
          if (typeof d.leagueName === "string")
            hydration.leagueName = d.leagueName;
          // Platform drives Step 3's apply instructions, the Yahoo
          // attribution block, and the share payload. Older payloads lack it;
          // the "sleeper" default stands for those. importSource comes along
          // so a later Back lands on the same dropdown selection.
          if (
            d.platform === "sleeper" ||
            d.platform === "espn" ||
            d.platform === "yahoo" ||
            d.platform === "manual"
          ) {
            hydration.platform = d.platform;
            hydration.importSource = d.platform;
          }
          hydration.furthestStep = "doubles";
          // Land where the user left off, clamped to Step 2: the generated
          // schedule is never persisted (regenerate fresh against current
          // avoidance), so "schedule" has nothing to render after a reload
          // and falls back to the matrix with Generate one tap away. A
          // stored "teams" (or an older payload without the field) keeps
          // the Step 1 default.
          if (d.step === "doubles" || d.step === "schedule") {
            hydration.step = "doubles";
          }
        }
      }
    } catch {
      // Ignore corrupt storage; fall back to empty state.
      hydration = {};
    }
    if (oauthPatch) {
      hydration = {
        ...hydration,
        selectedFormat: null,
        priorFormat: hydration.selectedFormat ?? null,
      };
    }
    patch({ ...hydration, ...oauthPatch, loading: false });
  }, [patch]);

  // Persist the active step on every navigation. The other save triggers
  // are data edits, and the navigation handlers can't do it themselves:
  // Step 1's Next saves and patches step in the same tick (the closure
  // trap - it would persist the pre-patch step), and the stepper/Back
  // clicks don't save at all. This effect runs after the patch flushes, so
  // the closure is fresh, and last-write-wins over any same-tick handler
  // save. The ref keeps it to actual step changes (saveToStorage's
  // identity changes with every dep); no saves while the import UI is up
  // (format null - persisting then would wipe the stored league's format).
  const lastSavedStepRef = useRef<Step | null>(null);
  const saveToStorage = useCallback(
    (extra: SaveToStorageExtra = {}) => {
      try {
        const payload = {
          step,
          teams,
          userIds,
          history,
          manualDoubles: [...manualDoubles],
          rivalryPins,
          format: selectedFormat,
          lookbackOverride,
          leagueName,
          platform,
          ...extra,
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // Storage may be full or unavailable; ignore.
      }
    },
    [
      step,
      teams,
      userIds,
      history,
      manualDoubles,
      rivalryPins,
      selectedFormat,
      lookbackOverride,
      leagueName,
      platform,
    ],
  );
  useEffect(() => {
    if (loading || !selectedFormat) return;
    if (lastSavedStepRef.current === step) return;
    lastSavedStepRef.current = step;
    saveToStorage();
  }, [step, loading, selectedFormat, saveToStorage]);

  const scheduleYear = new Date().getFullYear();
  const recommendedLookbackTotal = format
    ? format.lookback.hard + format.lookback.soft
    : 0;
  // Seasons strictly before the year being scheduled - the only ones that
  // drive avoidance. Save & Share records the in-progress season into history
  // for next-year restore, but it must not influence the current schedule, so
  // the lookback control sizes off this prior-season count, never
  // history.length. (history.length over-counts by one once the in-progress
  // season has been saved, which would inflate the displayed window.)
  const priorHistory = useMemo(
    () => priorSeasons(history, scheduleYear),
    [history, scheduleYear],
  );
  const priorSeasonCount = priorHistory.length;
  // Override may only dial the lookback down. Anything higher than the per-format
  // recommendation gets clamped so an over-constrained avoid set can't sneak in
  // from stale localStorage either. The window is also capped at the number of
  // prior seasons we actually have, so the display and the dropdown's controlled
  // value never claim more lookback than history can supply.
  const effectiveLookbackTotal = Math.min(
    lookbackOverride ?? recommendedLookbackTotal,
    recommendedLookbackTotal,
    priorSeasonCount,
  );
  const effectiveLookback = useMemo<LookbackWindow>(
    () =>
      format
        ? deriveLookback(effectiveLookbackTotal, format.lookback)
        : { hard: 0, soft: 0 },
    [effectiveLookbackTotal, format],
  );
  // The Step 2 matrix renders both triangles and queries every cell, so we
  // materialize the auto-avoid sets once per render instead of inside
  // cellAvoidType.
  const avoidSets = useMemo(
    () => buildAvoidMap(priorHistory, userIds, effectiveLookback),
    [priorHistory, userIds, effectiveLookback],
  );
  // Auto-avoid sets composed with the manual overlay. Consumed by the
  // schedule generator and by the rivalry-pin avoidance warning. Kept
  // separate from avoidSets because cellAvoidType needs the un-merged
  // version to distinguish manual cells from hard/soft cells.
  const mergedAvoidSets = useMemo(() => {
    const hard = new Set(avoidSets.hard);
    const soft = new Set(avoidSets.soft);
    manualDoubles.forEach((key) => {
      hard.add(key);
      soft.delete(key);
    });
    return { hard, soft };
  }, [avoidSets, manualDoubles]);

  function handleGenerate() {
    const { hard, soft } = mergedAvoidSets;
    const result = buildSchedule({
      teamCount,
      weekCount,
      hardAvoid: hard,
      softAvoid: soft,
      rivalryPins,
    });
    if (!result.ok) {
      patch({
        genError:
          result.reason === "generation-failed"
            ? rivalryPins.length > 0
              ? result.message
              : // Hard avoids come from manual avoids AND doubled history, so
                // the remedy names both controls that shrink the constraint set.
                "Could not generate a valid schedule. Try clearing some manual avoids or shrinking the Lookback Window."
            : result.message,
        saved: false,
        shareStatus: "idle",
        shareUrl: "",
        shareError: "",
        shareCopied: false,
      });
      return;
    }
    patch({
      genError: "",
      saved: false,
      shareStatus: "idle",
      shareUrl: "",
      shareError: "",
      shareCopied: false,
      schedule: result,
      displayWeeks: computeDisplayWeeks(result.weeks, teams, rivalryPins),
      selectedWeek: 0,
      step: "schedule",
      furthestStep: "schedule",
    });
  }

  function handleResetEverything() {
    resetState();
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }

  if (loading) {
    return (
      <div className="min-h-dvh px-4 py-6">
        <p className="mt-20 text-center text-slate-400">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col px-4 py-6 text-slate-200">
      {/* flex-1 keeps the content block-level inside the flex-col page wrapper.
          Without it the flex column stretches the step cards to the cross-axis,
          changing their width between steps on mobile. It also pushes <Footer/>
          (mt-auto) to the viewport bottom on short content. Don't remove it. */}
      <div className="flex-1">
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
            <h2 className={cls.cardTitle}>Import Your League</h2>
            <ImportSections
              state={state}
              patch={patch}
              saveToStorage={saveToStorage}
              platformRef={platformRef}
              importSourceRef={importSourceRef}
              importSeqRef={importSeqRef}
            />
          </div>
        ) : isEdgeCaseFormat ? (
          <div className={cls.card}>
            <h2 className={cls.cardTitle}>No schedule needed</h2>
            {format.variant === "pure-round-robin" ? (
              <p className={cls.hint}>
                {edgeCaseOpener}a pure round-robin where every team plays every
                opponent exactly once. There are no doubled matchups, so
                there&apos;s no fairness problem to solve and no rotational
                schedule needed.
              </p>
            ) : (
              <p className={cls.hint}>
                {edgeCaseOpener}a complete double round-robin where every team
                plays every opponent exactly twice. The schedule is fully
                determined - every pair is doubled - so there&apos;s no
                rotational fairness problem to solve.
              </p>
            )}
            <p className="text-[11px] text-slate-500 mt-3">
              {platform === "manual"
                ? "Use Reset below to clear and start over with a different league."
                : "Use Reset below to clear and re-import a different league."}
            </p>
          </div>
        ) : (
          <>
            <div className="flex justify-center gap-1 mb-6 flex-wrap">
              {(
                [
                  ["teams", "1. Import"],
                  ["doubles", "2. Review"],
                  ["schedule", "3. Schedule"],
                ] as [Step, string][]
              ).map(([key, label]) => {
                const disabled =
                  STEP_ORDER.indexOf(key) > STEP_ORDER.indexOf(furthestStep);
                return (
                  <button
                    key={key}
                    onClick={() => setStep(key)}
                    disabled={disabled}
                    className={`${cls.navBtn} bg-transparent border ${
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
              <StepImport
                state={state}
                patch={patch}
                saveToStorage={saveToStorage}
                stepOrder={STEP_ORDER}
              />
            )}

            {/* ═══ STEP 2: AVOID ═══ */}
            {step === "doubles" && format && (
              <StepReview
                state={state}
                patch={patch}
                saveToStorage={saveToStorage}
                format={format}
                avoidSets={avoidSets}
                mergedAvoidSets={mergedAvoidSets}
                effectiveLookback={effectiveLookback}
                effectiveLookbackTotal={effectiveLookbackTotal}
                recommendedLookbackTotal={recommendedLookbackTotal}
                priorSeasonCount={priorSeasonCount}
                showHeaderTooltip={showHeaderTooltip}
                hideHeaderTooltip={hideHeaderTooltip}
                onGenerate={handleGenerate}
              />
            )}

            {/* ═══ STEP 3: SCHEDULE ═══ */}
            {step === "schedule" && (
              <StepSchedule
                state={state}
                patch={patch}
                saveToStorage={saveToStorage}
                scheduleYear={scheduleYear}
                onGenerate={handleGenerate}
              />
            )}
          </>
        )}

        {selectedFormat && (
          <div className="max-w-[700px] mx-auto mt-6 text-center">
            {!confirmReset ? (
              <div className="inline-flex gap-2 items-center justify-center flex-wrap">
                <button
                  className={`${cls.navBtn} bg-transparent border border-slate-700 text-slate-400 hover:border-slate-500`}
                  onClick={() => {
                    if (step === "teams") {
                      // Stash the format as the re-import baseline: the
                      // import flow's formatChanged check needs to know the
                      // shape of the league whose teams/history stay loaded.
                      patch({
                        selectedFormat: null,
                        priorFormat: selectedFormat,
                        step: "teams",
                        furthestStep: "teams",
                      });
                    } else {
                      setStep(step === "schedule" ? "doubles" : "teams");
                    }
                  }}
                >
                  ← Back
                </button>
                <button
                  className={`${cls.navBtn} bg-transparent border border-red-700 text-red-400 hover:text-red-300 hover:border-red-600`}
                  onClick={() => setConfirmReset(true)}
                >
                  Reset
                </button>
              </div>
            ) : (
              <div className="inline-flex gap-2 items-center flex-wrap justify-center">
                <span className="text-[11px] text-red-400">
                  Reset everything? Can&apos;t be undone.
                </span>
                <button
                  className={cls.dangerBtn}
                  onClick={handleResetEverything}
                >
                  Yes, reset
                </button>
                <button
                  className={cls.cancelBtn}
                  onClick={() => setConfirmReset(false)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <Footer />

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
