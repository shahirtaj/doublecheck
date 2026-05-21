"use client";

import { useState } from "react";
import Link from "next/link";
import { pairKey } from "@/lib/algorithm";

type RivalryPlacement = {
  teamA: number;
  teamB: number;
  pinnedWeek: number | null;
  placedWeek: number;
};

type Props = {
  format: { teamCount: number; weekCount: number };
  leagueName?: string;
  seasonYear?: number;
  teams: string[];
  weeks: [number, number][][];
  doubledPairs: string[];
  rivalryPlacements: RivalryPlacement[];
};

export function SharedScheduleView({
  format,
  leagueName,
  seasonYear,
  teams,
  weeks,
  doubledPairs,
  rivalryPlacements,
}: Props) {
  const [selectedWeek, setSelectedWeek] = useState(0);
  const doubledSet = new Set(doubledPairs);
  // Keyed by `${pairKey}@${week}` so we can ask "is this specific pair-week
  // appearance pinned?" Natural double weeks aren't in this map and render red.
  const placementByWeekPair = new Map<string, RivalryPlacement>();
  for (const p of rivalryPlacements) {
    placementByWeekPair.set(`${pairKey(p.teamA, p.teamB)}@${p.placedWeek}`, p);
  }
  const summaryTitle =
    rivalryPlacements.length > 0 ? "Rival & Double Matchups" : "Double Matchups";

  const trimmedName = leagueName?.trim();
  const yearLabel = seasonYear ? `${seasonYear} ` : "";
  const heading = trimmedName
    ? `${trimmedName} ${yearLabel}Schedule`
    : `${format.teamCount}-team / ${format.weekCount}-week Schedule`;

  return (
    <>
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 max-w-[700px] mx-auto">
        <h2 className="text-base font-bold text-emerald-50 mb-3">{heading}</h2>

        <div className="bg-slate-900 border border-slate-700 rounded-lg px-3.5 py-2.5 mb-4">
          <strong className="text-slate-200 text-[13px]">Managers</strong>
          <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">
            {teams.join(", ")}
          </p>
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
          <h3 className="text-sm font-bold text-emerald-50 mb-3 text-center">Week {selectedWeek + 1}</h3>
          <div className="flex flex-col gap-2">
            {weeks[selectedWeek]!.map(([a, b], gi) => {
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
                  <span className="flex-1 text-[13px] text-slate-200 text-center">
                    {teams[a]}
                  </span>
                  <span className={`text-[11px] font-bold ${vsTone}`}>vs</span>
                  <span className="flex-1 text-[13px] text-slate-200 text-center">
                    {teams[b]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
            {summaryTitle}
          </summary>
          <div className="flex flex-col gap-1 mt-2">
            {teams.map((t, i) => {
              type Appearance = { week: number; isPinned: boolean };
              type Entry = {
                opponentIdx: number;
                name: string;
                appearances: Appearance[];
                anyPinned: boolean;
              };
              // Collect all appearances for team i, grouped by opponent.
              const byOpponent = new Map<number, Appearance[]>();
              weeks.forEach((week, wi) => {
                const W = wi + 1;
                for (const [a, b] of week) {
                  const key = pairKey(a, b);
                  const isDouble = doubledSet.has(key);
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
                        <span className={e.anyPinned ? "text-sky-400" : "text-red-400"}>
                          {e.name}
                        </span>
                        {" ("}
                        {e.appearances.map((app, j) => (
                          <span key={j}>
                            {j > 0 ? ", " : ""}
                            <span
                              className={app.isPinned ? "text-sky-400" : "text-red-400"}
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
      </div>

      <div className="max-w-[700px] mx-auto mt-8 text-center">
        <p className="text-xs text-slate-400 mb-3">
          Want a fair schedule for another league?
        </p>
        <Link
          href="/"
          className="inline-block bg-transparent text-emerald-400 border border-emerald-700 px-5 py-2.5 rounded-md text-[13px] font-semibold hover:border-emerald-600 hover:text-emerald-300"
        >
          Build your own →
        </Link>
      </div>
    </>
  );
}
