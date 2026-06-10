"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import Link from "next/link";
import {
  buildAvoidMap,
  buildSchedule,
  describeFormat,
  type LookbackWindow,
} from "@/lib/algorithm";
import { STEP_ORDER, STORAGE_KEY } from "./components/constants";
import type {
  ImportPlatform,
  ImportSource,
  SelectedFormat,
  Step,
} from "./components/types";
import {
  computeDisplayWeeks,
  deriveLookback,
  normalizeHistory,
  priorSeasons,
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
  const setFurthestStep = useCallback(
    (v: Step | ((prev: Step) => Step)) => {
      if (typeof v === "function") {
        dispatch({
          type: "patch",
          patch: {
            furthestStep: (v as (prev: Step) => Step)(state.furthestStep),
          },
        });
      } else {
        patch({ furthestStep: v });
      }
    },
    [patch, state.furthestStep],
  );
  const setSelectedFormat = useCallback(
    (v: SelectedFormat | null) => patch({ selectedFormat: v }),
    [patch],
  );
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

  // Hydrate from localStorage on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        let storedTeamCount = 0;
        const hydration: Partial<State> = {};
        if (
          d.format &&
          typeof d.format.teamCount === "number" &&
          typeof d.format.weekCount === "number" &&
          d.format.teamCount >= 2 &&
          d.format.teamCount % 2 === 0
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
          if (typeof d.lookbackOverride === "number")
            hydration.lookbackOverride = d.lookbackOverride;
          if (typeof d.leagueName === "string")
            hydration.leagueName = d.leagueName;
          hydration.furthestStep = "doubles";
        }
        patch({ ...hydration, loading: false });
        return;
      }
    } catch {
      // Ignore corrupt storage; fall back to empty state.
    }
    patch({ loading: false });
  }, [patch]);

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

    if (status === "connected") {
      // pendingYahooConnect bridges to fetchYahooLeagues, which lives inside
      // ImportSections — that component picks up the flag and runs the fetch.
      // importSource must be patched alongside platform: OAuth is a full-page
      // redirect, so importSource is back at its "sleeper" default, and the
      // auto-load fetch's stale() guard checks importSourceRef at response
      // time - without this the response is discarded and the UI hangs on
      // the loading status.
      patch({
        platform: "yahoo",
        importSource: "yahoo",
        pendingYahooConnect: true,
      });
    } else if (status === "error") {
      patch({
        platform: "yahoo",
        importSource: "yahoo",
        importStatus: "error",
        importMsg: `Yahoo Fantasy connection failed: ${(reason || "unknown").replace(/_/g, " ")}.`,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveToStorage = useCallback(
    (extra: SaveToStorageExtra = {}) => {
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
    [
      teams,
      userIds,
      history,
      manualDoubles,
      selectedFormat,
      lookbackOverride,
      leagueName,
    ],
  );

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
              : "Could not generate a valid schedule. Try clearing some avoid-pairs."
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
      displayWeeks: computeDisplayWeeks(result.weeks, teams),
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
              recommendedLookbackTotal={recommendedLookbackTotal}
            />
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
                : a pure round-robin where every team plays every opponent
                exactly once. There are no doubled matchups, so there&apos;s no
                fairness problem to solve and no rotational schedule needed.
              </p>
            ) : (
              <p className={cls.hint}>
                Detected{" "}
                <strong className="text-slate-200">
                  {teamCount}-team / {weekCount}-week
                </strong>
                : a complete double round-robin where every team plays every
                opponent exactly twice. The schedule is fully determined - every
                pair is doubled - so there&apos;s no rotational fairness problem
                to solve.
              </p>
            )}
            <p className="text-[11px] text-slate-500 mt-3">
              Use Reset below to clear and re-import a different league.
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
