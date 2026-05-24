import { pairKey, type Matching, type RivalryPlacement } from "@/lib/algorithm";

type Props = {
  teams: string[];
  weeks: Matching[];
  doubledPairs: Set<string> | string[];
  rivalryPlacements: ReadonlyArray<RivalryPlacement>;
};

export function DoubleMatchupsSummary({
  teams,
  weeks,
  doubledPairs,
  rivalryPlacements,
}: Props) {
  const doubledSet =
    doubledPairs instanceof Set ? doubledPairs : new Set(doubledPairs);
  // Keyed by `${pairKey}@${week}` so we can ask "is this specific pair-week
  // appearance pinned?" Natural double weeks aren't in this map and render red.
  const placementByWeekPair = new Map<string, RivalryPlacement>();
  for (const p of rivalryPlacements) {
    placementByWeekPair.set(`${pairKey(p.teamA, p.teamB)}@${p.placedWeek}`, p);
  }
  const summaryTitle =
    rivalryPlacements.length > 0
      ? "Double & Rival Matchups"
      : "Double Matchups";

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
        {summaryTitle}
      </summary>
      <div className="flex flex-col gap-1 mt-2">
        {[...teams.entries()]
          .sort((a, b) =>
            a[1].localeCompare(b[1], undefined, { numeric: true }),
          )
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
                      <span
                        className={
                          e.anyPinned ? "text-sky-400" : "text-red-400"
                        }
                      >
                        {e.name}
                      </span>
                      {" ("}
                      {e.appearances.length === 1 ? "Week " : "Weeks "}
                      {e.appearances.map((app, j) => (
                        <span key={j}>
                          {j > 0 ? ", " : ""}
                          <span
                            className={
                              app.isPinned ? "text-sky-400" : "text-red-400"
                            }
                          >
                            {app.week}
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
  );
}
