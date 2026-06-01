"use client";

import { useState } from "react";
import Link from "next/link";
import { pairKey, type RivalryPlacement } from "@/lib/algorithm";
import { MatchupSummary } from "@/app/components/MatchupSummary";
import { ScheduleHeading } from "@/app/components/ScheduleHeading";
import { buildScheduleText } from "@/app/components/utils";
import { YahooAttribution } from "@/app/components/YahooAttribution";
import { cls } from "@/app/components/styles";

type Props = {
  slug: string;
  format: { teamCount: number; weekCount: number };
  leagueName?: string;
  seasonYear?: number;
  // Source platform of the originating import — drives the apply-
  // instructions line. Optional for backward compat with older share links.
  platform?: string;
  teams: string[];
  weeks: [number, number][][];
  // Optional: home/away display assignments. Older share links predate
  // this field; we fall back to the raw weeks order when absent.
  displayWeeks?: [number, number][][];
  doubledPairs: string[];
  rivalryPlacements: RivalryPlacement[];
};

export function SharedScheduleView({
  slug,
  format,
  leagueName,
  seasonYear,
  platform,
  teams,
  weeks,
  displayWeeks,
  doubledPairs,
  rivalryPlacements,
}: Props) {
  // Summary sections continue to use the raw weeks (they only care which
  // teams played, not which side they appeared on); only the week viewer
  // honors the home/away assignment.
  const viewerWeeks = displayWeeks ?? weeks;
  const [selectedWeek, setSelectedWeek] = useState(0);
  const [scheduleCopied, setScheduleCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const doubledSet = new Set(doubledPairs);
  // Keyed by `${pairKey}@${week}` so we can ask "is this specific pair-week
  // appearance pinned?" Natural double weeks aren't in this map and render red.
  const placementByWeekPair = new Map<string, RivalryPlacement>();
  for (const p of rivalryPlacements) {
    placementByWeekPair.set(`${pairKey(p.teamA, p.teamB)}@${p.placedWeek}`, p);
  }

  const trimmedName = leagueName?.trim();
  const yearLabel = seasonYear ? `${seasonYear} ` : "";
  // Heading prefix for the copied text export only; the <h2> renders via
  // ScheduleHeading (which owns the no-name fallback). The copy export omits
  // the heading entirely when there's no league name, so this needs no fallback.
  const heading = trimmedName ? `${trimmedName} ${yearLabel}Schedule` : "";

  function formatScheduleText(): string {
    const headingPrefix = trimmedName ? `${heading}\n\n` : "";
    return buildScheduleText(viewerWeeks, teams, platform, headingPrefix);
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/s/${slug}`,
      );
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); the URL is still
      // available in the address bar as a fallback.
    }
  }

  async function handleCopySchedule() {
    try {
      await navigator.clipboard.writeText(formatScheduleText());
      setScheduleCopied(true);
      setTimeout(() => setScheduleCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); the textarea is
      // still selectable manually as a fallback.
    }
  }

  return (
    <>
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 max-w-[700px] mx-auto">
        <div className="flex items-center justify-between gap-3 mb-3">
          <ScheduleHeading
            name={leagueName ?? ""}
            yearLabel={yearLabel}
            fallback={`${format.teamCount}-team / ${format.weekCount}-week Schedule`}
            className="text-base font-bold text-emerald-50"
          />
          <button
            className={`${cls.secondaryBtn} shrink-0 whitespace-nowrap`}
            onClick={handleCopyLink}
          >
            {linkCopied ? "✓ Copied" : "Copy link"}
          </button>
        </div>

        <div className="flex gap-1 flex-wrap mb-4">
          {weeks.map((_, i) => (
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
          <h3 className="text-sm font-bold text-emerald-50 mb-3 text-center">
            Week {selectedWeek + 1}
          </h3>
          <div className="flex flex-col gap-2">
            {viewerWeeks[selectedWeek]!.map(([a, b], gi) => {
              const key = pairKey(a, b);
              const isDouble = doubledSet.has(key);
              const isPinnedHere = placementByWeekPair.has(
                `${key}@${selectedWeek + 1}`,
              );
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
                  <span className={`shrink-0 text-[11px] font-bold ${vsTone}`}>
                    vs
                  </span>
                  <span className="flex-1 min-w-0 break-words text-[13px] text-slate-200 text-center">
                    {teams[b]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <MatchupSummary
          teams={teams}
          weeks={weeks}
          doubledPairs={doubledPairs}
          rivalryPlacements={rivalryPlacements}
        />

        <p className="text-[11px] text-slate-300 mt-4 text-center">
          {platform === "sleeper" ? (
            <>
              To apply this schedule, edit your matchups in Sleeper&apos;s
              League Settings (
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
              Playoffs &gt; Edit Schedules and update each week&apos;s matchups
              (
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

      <div className="max-w-[700px] mx-auto mt-8 text-center">
        <p className="text-xs text-slate-400 mb-3">
          Want a fair schedule for another league?
        </p>
        <Link
          href="/"
          className="inline-block bg-transparent text-emerald-400 border border-emerald-700 px-5 py-2.5 rounded-md text-[13px] font-semibold hover:border-emerald-600 hover:text-emerald-300"
        >
          Generate Your Own →
        </Link>
      </div>
    </>
  );
}
