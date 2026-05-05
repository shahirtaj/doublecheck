"use client";

import { useState } from "react";
import { unpackPairKey } from "@/lib/algorithm";

type Props = {
  format: { teamCount: number; weekCount: number };
  teams: string[];
  weeks: [number, number][][];
  doubledPairs: string[];
};

export function SharedScheduleView({ format, teams, weeks, doubledPairs }: Props) {
  const [selectedWeek, setSelectedWeek] = useState(0);
  const doubledSet = new Set(doubledPairs);

  return (
    <>
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 max-w-[700px] mx-auto">
        <h2 className="text-base font-bold text-emerald-50 mb-1.5">Shared Schedule</h2>
        <p className="text-xs text-slate-400 leading-relaxed mb-3">
          <strong className="text-slate-200">
            {format.teamCount}-team / {format.weekCount}-week
          </strong>{" "}
          league.
        </p>

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
          <h3 className="text-sm font-bold text-emerald-50 mb-3">Week {selectedWeek + 1}</h3>
          <div className="flex flex-col gap-2">
            {weeks[selectedWeek]!.map(([a, b], gi) => {
              const key = a < b ? `${a}-${b}` : `${b}-${a}`;
              const isDouble = doubledSet.has(key);
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
              doubledSet.forEach((key) => {
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
      </div>

      <div className="max-w-[700px] mx-auto mt-6 text-center">
        <p className="text-[11px] text-slate-500">
          Shared schedule ·{" "}
          <a
            href="https://doublecheckff.com"
            className="text-emerald-400 hover:text-emerald-300"
          >
            generate your own at doublecheckff.com
          </a>
        </p>
      </div>
    </>
  );
}
