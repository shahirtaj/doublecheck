import type { LookbackWindow, Matching } from "@/lib/algorithm";
import type { ImportPlatform, ImportedSeasonRecord, SelectedFormat } from "./types";

// Map a single-number lookback override (the total of hard + soft) back into
// the LookbackWindow shape buildAvoidMap expects. We preserve the format's
// hard count when possible, with any extra falling into soft.
export function deriveLookback(override: number, formatLookback: LookbackWindow): LookbackWindow {
  const total = Math.max(0, Math.floor(override));
  const hard = Math.min(total, formatLookback.hard);
  const soft = Math.max(0, total - hard);
  return { hard, soft };
}

// Derive a format from an imported season record. Returns null if the season
// doesn't carry enough information (missing regWeeks, odd team count, or week
// count outside the round-robin range) for us to set the format from it.
export function detectFormatFromImport(season: ImportedSeasonRecord): SelectedFormat | null {
  const teamCount = season.teamNames?.length ?? 0;
  const weekCount = season.regWeeks ?? 0;
  if (teamCount < 2 || teamCount % 2 !== 0) return null;
  if (weekCount < teamCount - 1 || weekCount > 2 * (teamCount - 1)) return null;
  return { teamCount, weekCount };
}

// "espn" needs to render as the full acronym; the other platforms are normal
// proper nouns and just want title-case.
export function platformLabel(platform: ImportPlatform): string {
  if (platform === "espn") return "ESPN";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

// Pull the 8-char slug out of a share-link input. Accepts a full URL
// (.../s/<slug>), a relative path (/s/<slug>), or a bare slug — anything
// else returns null. Used by the "Import from link" restore flow.
const SLUG_RE = /^[a-z0-9]{8}$/;
export function extractSlug(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/\/s\/([a-z0-9]{8})(?:[/?#]|$)/);
  if (urlMatch) return urlMatch[1]!;
  return SLUG_RE.test(trimmed) ? trimmed : null;
}

// Assign a deterministic home/away display order to every matchup in the
// schedule, then sort each week's matchups by the left-side team name.
// Display-only — the underlying pair tuple, its index in schedule.weeks,
// and every algorithm/storage system are untouched. Greedy: for each
// matchup [a, b], whichever team has fewer left appearances across all
// prior weeks goes on the left, with (a + b + weekIndex) % 2 as the
// tiebreaker. Produces a balanced 7/7 split in 14-week formats and 7/8
// in 15-week formats.
export function computeDisplayWeeks(
  weeks: ReadonlyArray<Matching>,
  teams: ReadonlyArray<string>,
): [number, number][][] {
  const leftCount = new Array<number>(teams.length).fill(0);
  return weeks.map((week, weekIndex) => {
    const assigned: [number, number][] = week.map(([a, b]) => {
      let left: number;
      let right: number;
      const la = leftCount[a]!;
      const lb = leftCount[b]!;
      if (la < lb) {
        [left, right] = [a, b];
      } else if (lb < la) {
        [left, right] = [b, a];
      } else if ((a + b + weekIndex) % 2 === 0) {
        [left, right] = [a, b];
      } else {
        [left, right] = [b, a];
      }
      leftCount[left]!++;
      return [left, right];
    });
    return assigned.sort(([a1], [a2]) =>
      teams[a1]!.localeCompare(teams[a2]!, undefined, { numeric: true }),
    );
  });
}

export function abbrev(name: string): string {
  return name.length > 7 ? name.slice(0, 7) : name;
}
