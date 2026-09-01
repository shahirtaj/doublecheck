"use client";

import { type MouseEvent, type MutableRefObject } from "react";
import {
  pairKey,
  unpackPairKey,
  type Matching,
  type PairKey,
  type RivalryPlacement,
  type SeasonHistory,
} from "@/lib/algorithm";
import { MatchupSummary } from "./MatchupSummary";
import { ScheduleHeading } from "./ScheduleHeading";
import { YahooAttribution } from "./YahooAttribution";
import { buildScheduleText } from "./utils";
import { cls } from "./styles";
import type { Patch, SaveToStorageFn, State } from "./state";

type StepScheduleProps = {
  state: State;
  patch: Patch;
  saveToStorage: SaveToStorageFn;
  scheduleYear: number;
  onGenerate: () => void;
  generateSeqRef: MutableRefObject<number>;
};

export function StepSchedule(props: StepScheduleProps) {
  const {
    state,
    patch,
    saveToStorage,
    scheduleYear,
    onGenerate,
    generateSeqRef,
  } = props;
  const {
    schedule,
    displayWeeks,
    teams,
    userIds,
    leagueName,
    selectedWeek,
    saved,
    generating,
    shareStatus,
    shareUrl,
    shareError,
    shareCopied,
    scheduleCopied,
    platform,
    selectedFormat,
    history,
    manualDoubles,
    rivalryPins,
    sourceLeagueId,
  } = state;

  if (!schedule) return null;

  async function handleSaveAndShare() {
    if (!schedule || !selectedFormat) return;
    // A Regenerate (or a Step 2 re-Generate) while the POST is in flight
    // resets share state for a schedule this response doesn't describe -
    // landing it would attach the old schedule's link, or its error, to the
    // new schedule. Bail after every await and at the top of the catch, the
    // same supersession pattern as the import fetch helpers.
    const requestSeq = generateSeqRef.current;
    const stale = () => generateSeqRef.current !== requestSeq;

    // Already shared this exact schedule — the existing link still points at
    // it, so there's nothing to do. Regenerate clears shareUrl and saved
    // before the next gen, so a fresh schedule still gets a fresh link.
    if (saved && shareUrl) {
      patch({ shareStatus: "ready" });
      return;
    }

    // Save once per generated schedule. Subsequent clicks just re-share so the
    // history doesn't accumulate duplicate entries.
    let nextHistory = history;
    let nextManualDoubles: PairKey[] = [...manualDoubles];
    if (!saved) {
      const seasonLabel = String(new Date().getFullYear());
      // Prefer userid format - IDs follow managers across team renames. A
      // pair whose member has no user ID is skipped openly rather than
      // written as a broken half-key ("ABC:") that resolveKey would silently
      // drop at read time (same effective avoidance, but deliberate). Index
      // format only when no team has an ID; see buildImportedHistoryRows
      // (utils.ts) for why missing IDs don't demote the row to index.
      const hasUserIds = userIds.some((id) => id != null);

      let doubles: PairKey[];
      let entryFormat: "userid" | "index";
      if (hasUserIds) {
        doubles = [...schedule.doubledPairs].flatMap((key) => {
          const [a, b] = unpackPairKey(key);
          const ua = userIds[a];
          const ub = userIds[b];
          return ua != null && ub != null ? [[ua, ub].sort().join(":")] : [];
        });
        entryFormat = "userid";
      } else {
        doubles = [...schedule.doubledPairs];
        entryFormat = "index";
      }

      const entry: SeasonHistory = {
        season: seasonLabel,
        doubles,
        format: entryFormat,
      };
      const withoutCurrent = history.filter((h) => h.season !== seasonLabel);
      nextHistory = [...withoutCurrent, entry];
      nextManualDoubles = [];
      patch({
        history: nextHistory,
        manualDoubles: new Set(),
        saved: true,
      });
      saveToStorage({ history: nextHistory, manualDoubles: [] });
    }

    patch({
      shareStatus: "loading",
      shareError: "",
      shareCopied: false,
    });
    try {
      const payload = {
        format: selectedFormat,
        leagueName,
        seasonYear: scheduleYear,
        platform,
        // Optional in the payload (undefined for manual leagues and older
        // states); lets a restore offer one-click re-import.
        sourceLeagueId: sourceLeagueId ?? undefined,
        teams,
        userIds,
        history: nextHistory,
        manualDoubles: nextManualDoubles,
        rivalryPins,
        schedule: {
          weeks: schedule.weeks,
          displayWeeks: displayWeeks ?? undefined,
          doubledPairs: [...schedule.doubledPairs],
          softRepeated: schedule.softRepeated,
          hardRepeated: schedule.hardRepeated,
          clean: schedule.clean,
          // schedule.format is deliberately not sent - it's derivable from
          // the top-level format, and the share route doesn't store it.
          rivalryPlacements: schedule.rivalryPlacements,
        },
      };
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (stale()) return;
      const data = await res.json();
      if (stale()) return;
      if (!res.ok)
        throw new Error(data?.error || `Request failed (HTTP ${res.status}).`);
      const fullUrl = `${window.location.origin}${data.url}`;
      patch({ shareUrl: fullUrl, shareStatus: "ready" });
    } catch (e) {
      if (stale()) return;
      patch({
        shareStatus: "error",
        shareError: (e as Error).message || "Could not create a share link.",
      });
    }
  }

  async function handleCopyShareLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      patch({ shareCopied: true });
      setTimeout(() => patch({ shareCopied: false }), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); leave the URL
      // selectable in the input as fallback.
    }
  }

  // Reads the same text that the Copy Full Schedule textarea displays, so the
  // dedicated Copy button stays in lockstep with what the user sees there.
  function formatScheduleText(): string {
    if (!schedule) return "";
    // Trim to match the on-screen heading (ScheduleHeading trims), so a name
    // with stray whitespace can't display trimmed but copy out untrimmed.
    const trimmedName = leagueName.trim();
    const headingPrefix = trimmedName
      ? `${trimmedName} ${scheduleYear} Schedule\n\n`
      : "";
    return buildScheduleText(
      displayWeeks ?? schedule.weeks,
      teams,
      platform,
      headingPrefix,
    );
  }

  async function handleCopySchedule() {
    if (!schedule) return;
    try {
      await navigator.clipboard.writeText(formatScheduleText());
      patch({ scheduleCopied: true });
      setTimeout(() => patch({ scheduleCopied: false }), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); user can still
      // select and copy the textarea contents manually.
    }
  }

  return (
    <div className={cls.card}>
      <ScheduleHeading
        name={leagueName}
        yearLabel={`${scheduleYear} `}
        fallback="Generated Schedule"
        className={cls.cardTitle}
      />

      {schedule.hardRepeated.length > 0 && (
        <div className="bg-amber-950 border border-amber-800 rounded-md px-3 py-2 text-[11px] text-amber-400 mb-3">
          ⚠ {schedule.hardRepeated.length} hard-avoid pair(s) couldn&apos;t be
          skipped (marked ★). This shouldn&apos;t happen with clean history.
        </div>
      )}
      {schedule.softRepeated.length > 0 && (
        <p className="text-[11px] text-slate-400 mb-3">
          {schedule.softRepeated.length} pair(s) repeated from older seasons -
          this is expected to maintain the rotation.
        </p>
      )}

      <div className="flex gap-1 flex-wrap mb-4">
        {schedule.weeks.map((_: Matching, i: number) => (
          <button
            key={i}
            onClick={() => patch({ selectedWeek: i })}
            aria-label={`Week ${i + 1}`}
            aria-pressed={selectedWeek === i}
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
        return (
          <>
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-4">
              <h3 className="text-sm font-bold text-emerald-50 mb-3 text-center">
                Week {selectedWeek + 1}
              </h3>
              <div className="flex flex-col gap-2">
                {(displayWeeks ?? schedule.weeks)[selectedWeek]!.map(
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
                        <span className="flex-1 min-w-0 break-words text-[13px] text-slate-200 text-center">
                          {teams[a]}
                        </span>
                        <span
                          className={`shrink-0 text-[11px] font-bold ${vsTone}`}
                        >
                          vs
                        </span>
                        <span className="flex-1 min-w-0 break-words text-[13px] text-slate-200 text-center">
                          {teams[b]}
                        </span>
                        {isRepeat && (
                          <span className="shrink-0 text-amber-400 text-sm ml-1">
                            ★
                          </span>
                        )}
                      </div>
                    );
                  },
                )}
              </div>
            </div>

            <MatchupSummary
              teams={teams}
              weeks={schedule.weeks}
              doubledPairs={schedule.doubledPairs}
              rivalryPlacements={schedule.rivalryPlacements}
            />
          </>
        );
      })()}

      <div className="flex gap-3 mt-6 flex-wrap items-center justify-center">
        <button
          className={cls.secondaryBtn}
          onClick={onGenerate}
          disabled={generating}
        >
          {generating ? "Generating…" : "Regenerate"}
        </button>
        <button
          className={cls.primaryBtn}
          onClick={handleSaveAndShare}
          // Also disabled while generating: a save started mid-run would
          // capture the post-bump seq and attach the OLD schedule's link to
          // the new schedule when the run lands.
          disabled={shareStatus === "loading" || generating}
        >
          {shareStatus === "loading" ? "Saving…" : "Save & Share"}
        </button>
        {saved && (
          <span className="text-emerald-400 text-[13px] font-semibold">
            ✓ Saved
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
          <p className="text-[11px] text-slate-400 mt-2">
            Bookmark your share link - you can restore your league from it next
            season on any device.
          </p>
        </div>
      )}
      {shareStatus === "error" && shareError && (
        <p className={cls.error}>{shareError}</p>
      )}

      <p className="text-[11px] text-slate-300 mt-4 text-center">
        {platform === "sleeper" ? (
          <>
            To apply this schedule, edit your matchups in Sleeper&apos;s League
            Settings (
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
            To apply this schedule, go to LM Tools &gt; Edit Head-to-Head
            Schedule and update each week&apos;s matchups (
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
            To apply this schedule, go to Commissioner &gt; Schedules &amp;
            Playoffs &gt; Edit Schedules and update each week&apos;s matchups (
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
          <>
            To apply this schedule, enter these matchups in your league
            settings.
          </>
        )}
      </p>

      {platform === "yahoo" && <YahooAttribution className="mt-4" />}

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
          Full Schedule (Text)
        </summary>
        <textarea
          readOnly
          className="w-full bg-slate-900 text-slate-400 border border-slate-700 rounded-md p-2.5 text-[11px] font-mono resize-y mt-2 box-border"
          value={formatScheduleText()}
          rows={12}
        />
        <div className="mt-2 flex justify-center">
          <button className={cls.secondaryBtn} onClick={handleCopySchedule}>
            {scheduleCopied ? "✓ Copied" : "Copy"}
          </button>
        </div>
      </details>
    </div>
  );
}
