import { describeFormat } from "@/lib/algorithm";
import type { LookbackWindow, Matching, SeasonHistory } from "@/lib/algorithm";
import { CURRENT_YEAR } from "./constants";
import type {
  FailedImportSeason,
  ImportPlatform,
  ImportedSeasonRecord,
  SelectedFormat,
} from "./types";

// Map a single-number lookback override (the total of hard + soft) back into
// the LookbackWindow shape buildAvoidMap expects. We preserve the format's
// hard count when possible, with any extra falling into soft.
export function deriveLookback(
  override: number,
  formatLookback: LookbackWindow,
): LookbackWindow {
  const total = Math.max(0, Math.floor(override));
  const hard = Math.min(total, formatLookback.hard);
  const soft = Math.max(0, total - hard);
  return { hard, soft };
}

// Derive a format from an imported season record. Returns null if the season
// doesn't carry enough information (missing regWeeks, odd team count, or week
// count outside the round-robin range) for us to set the format from it.
export function detectFormatFromImport(
  season: ImportedSeasonRecord,
): SelectedFormat | null {
  const teamCount = season.teamNames?.length ?? 0;
  const weekCount = season.regWeeks ?? 0;
  if (teamCount < 2 || teamCount % 2 !== 0) return null;
  if (weekCount < teamCount - 1 || weekCount > 2 * (teamCount - 1)) return null;
  return { teamCount, weekCount };
}

// "espn" needs to render as the full acronym; "yahoo" renders with the
// "Fantasy" suffix per Yahoo's API branding requirements; the other platforms
// are normal proper nouns and just want title-case.
export function platformLabel(platform: ImportPlatform): string {
  if (platform === "espn") return "ESPN";
  if (platform === "yahoo") return "Yahoo Fantasy";
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
  // NOTE: Order-dependent — leftCount is mutated during iteration so each
  // matchup's home/away assignment depends on assignments made in earlier
  // weeks. Do not parallelize or reorder.
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
  return name.length > 8 ? name.slice(0, 8) : name;
}

// Seasons strictly before `year`. Avoidance is scoped to prior seasons:
// Save & Share records the current season into history so a next-year
// restore has it in the avoidance window, but mid-session — scheduling that
// same year — it must not drive avoidance or the schedule would avoid
// itself. Unparseable years are kept (treated as historical) so this only
// ever drops the current (or any future) year.
export function priorSeasons(
  history: readonly SeasonHistory[],
  year: number,
): SeasonHistory[] {
  return history.filter((h) => {
    const y = Number(h.season);
    return !Number.isFinite(y) || y < year;
  });
}

// One row per season, oldest first. Keeps the LAST row for each season label
// so fresher data wins over whatever came before it, then sorts ascending by
// numeric year (stable sort, so rows with unparseable years keep their
// relative order - same comparator as Add Past Season). buildAvoidMap ages
// entries by array index, so a duplicated year double-counts that season and
// an out-of-order row corrupts the whole avoidance window.
export function normalizeHistory(
  rows: readonly SeasonHistory[],
): SeasonHistory[] {
  const lastIndexBySeason = new Map<string, number>();
  rows.forEach((row, i) => lastIndexBySeason.set(row.season, i));
  return rows
    .filter((row, i) => lastIndexBySeason.get(row.season) === i)
    .sort((a, b) => {
      const aN = Number(a.season);
      const bN = Number(b.season);
      if (Number.isNaN(aN) || Number.isNaN(bN)) return 0;
      return aN - bN;
    });
}

// Merge freshly imported seasons into existing history. Imported data always
// wins: an existing row for the same year (a manual edit, or a Save & Share
// row whose generated doubles differ from the actually played ones) is
// replaced rather than duplicated, and the result is re-sorted
// chronologically. A Save & Share row for the in-progress season may be
// replaced too: most platforms only return completed seasons, but a
// mid-season Sleeper import includes the current year. That's fine - the
// upsert keeps one row, and priorSeasons keeps the current year out of
// avoidance.
export function mergeImportedHistory(
  existing: readonly SeasonHistory[],
  imported: readonly SeasonHistory[],
): SeasonHistory[] {
  return normalizeHistory([...existing, ...imported]);
}

// "2023" -> 2023, anything blank or non-numeric -> null. Number("") is 0,
// so the blank check has to come first.
function parseYear(label: string | undefined): number | null {
  const trimmed = (label ?? "").trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// Decide which imported seasons survive a partial import. buildAvoidMap ages
// history rows by array index anchored at the newest season, so a gap makes
// every older row read one age younger than reality and the missing season's
// doubles carry zero avoidance cost. A truncated-but-contiguous run ending at
// the newest season keeps the same semantics over a shorter window; a gapped
// run lies — so seasons OLDER than the newest unfilled gap are withheld.
// `failed` is every attempted year missing from `seasons`, whatever the
// cause: a season the route couldn't fetch, or one the client's format
// filter dropped for having a different roster size. The decision is
// cause-blind; callers own cause-specific messaging.
// A failed year already covered by an existing history row (or by another
// imported season) isn't a gap: the merge fills the hole. Failed years
// without a numeric label can't be positioned, so they're ignored; an
// imported season without a numeric label is withheld once a gap exists
// (it can't be proven newer than the gap).
// `seasons` is most-recent-first (the server response order) and `kept`
// preserves that order. `gapYears` lists the unfilled failed years newest
// first; `withheldYears` lists the labels of the dropped seasons.
export function withholdPreGapSeasons(
  seasons: readonly ImportedSeasonRecord[],
  failed: readonly FailedImportSeason[],
  existingHistory: readonly SeasonHistory[],
): {
  kept: ImportedSeasonRecord[];
  withheldYears: string[];
  gapYears: string[];
} {
  const covered = new Set<number>();
  for (const row of existingHistory) {
    const y = parseYear(row.season);
    if (y != null) covered.add(y);
  }
  for (const season of seasons) {
    const y = parseYear(season.seasonYear);
    if (y != null) covered.add(y);
  }

  const gapNums = [
    ...new Set(
      failed
        .map((f) => parseYear(f.season))
        .filter((y): y is number => y != null && !covered.has(y)),
    ),
  ].sort((a, b) => b - a);

  if (gapNums.length === 0) {
    return { kept: [...seasons], withheldYears: [], gapYears: [] };
  }

  const newestGap = gapNums[0]!;
  const kept: ImportedSeasonRecord[] = [];
  const withheldYears: string[] = [];
  for (const season of seasons) {
    const y = parseYear(season.seasonYear);
    if (y != null && y > newestGap) {
      kept.push(season);
    } else {
      withheldYears.push((season.seasonYear ?? "").trim() || "?");
    }
  }
  return { kept, withheldYears, gapYears: gapNums.map(String) };
}

// Cause-specific messaging for a gap-withholding decision.
// withholdPreGapSeasons is cause-blind; this is where the causes split,
// because the remedies differ - retry can recover a failed fetch, never a
// roster-filtered season. `gapYears` and `failed` come from the same
// withholding decision; `dropped` is the roster-filtered season records
// (their team counts feed the message); `detected` is the format anchored
// on the newest season.
export function describeWithholdingGap(
  gapYears: readonly string[],
  failed: readonly FailedImportSeason[],
  dropped: readonly ImportedSeasonRecord[],
  detected: SelectedFormat,
): { cause: string; remedy: string } {
  let cause = "";
  let remedy = "";
  if (gapYears.length > 0) {
    const failedYearSet = new Set(failed.map((f) => f.season.trim()));
    const rosterSizeByYear = new Map<string, number>();
    for (const s of dropped) {
      const y = (s.seasonYear ?? "").trim();
      if (y) rosterSizeByYear.set(y, s.teamNames?.length ?? 0);
    }
    // Every gap year came from one of the two source lists, and a
    // fetch-failed year can't also be a roster drop (it was never fetched).
    const fetchGaps = gapYears.filter((y) => failedYearSet.has(y));
    const rosterGaps = gapYears.filter((y) => !failedYearSet.has(y));

    const causeParts: string[] = [];
    if (fetchGaps.length > 0) {
      causeParts.push(`${fetchGaps.join(", ")} failed to import`);
    }
    if (rosterGaps.length > 0) {
      causeParts.push(
        `${rosterGaps
          .map((y) => `${y} was a ${rosterSizeByYear.get(y)}-team season`)
          .join(" and ")} (this import is ${detected.teamCount} teams)`,
      );
    }
    cause = causeParts.join(", and ");

    // Only advertise a remedy Add Past Season can deliver: its year
    // dropdown reaches back the detected format's recommended lookback
    // from the current year. gapYears are numeric by construction
    // (withholdPreGapSeasons ignores non-numeric failed years).
    const lookback = describeFormat(
      detected.teamCount,
      detected.weekCount,
    ).lookback;
    const oldestOfferableYear = CURRENT_YEAR - (lookback.hard + lookback.soft);
    const fillableRosterGaps = rosterGaps.filter((y) => {
      const n = Number(y);
      return n >= oldestOfferableYear && n <= CURRENT_YEAR - 1;
    });
    if (rosterGaps.length === 0) {
      remedy = `Retry the import, or add ${fetchGaps.join(", ")} via Add Past Season and re-import.`;
    } else if (fetchGaps.length === 0) {
      remedy =
        fillableRosterGaps.length > 0
          ? `Retrying won't change this - to keep the older seasons, add ${fillableRosterGaps.join(", ")} via Add Past Season (marking ${fillableRosterGaps.length > 1 ? "each season's" : "that season's"} doubled matchups among the current teams), then re-import.`
          : `Retrying won't change this, and Add Past Season only reaches back to ${oldestOfferableYear}, so the older seasons can't be restored.`;
    } else {
      remedy =
        fillableRosterGaps.length > 0
          ? `Retrying may recover ${fetchGaps.join(", ")}; ${fillableRosterGaps.join(", ")} ${fillableRosterGaps.length > 1 ? "need" : "needs"} Add Past Season (marking doubles among the current teams) before a re-import can keep the older seasons.`
          : `Retrying may recover ${fetchGaps.join(", ")}, but ${rosterGaps.join(", ")} can't be restored (Add Past Season only reaches back to ${oldestOfferableYear}).`;
    }
  }
  return { cause, remedy };
}

// Import error for when nothing importable survives the withholding
// decision - the newest attempted season itself failed - carrying the same
// cause/remedy guidance as the partial-import warning.
export function withholdingErrorMessage(cause: string, remedy: string): string {
  return `${cause}, and every season that did load is older - keeping them would leave a gap in season history, which corrupts recency-based avoidance. ${remedy}`;
}

// Amber preview warning for a partial import: newer seasons survived, the
// ones behind the gap were withheld.
export function withholdingWarningMessage(
  cause: string,
  remedy: string,
  withheldYears: readonly string[],
): string {
  return `${cause}, so ${withheldYears.join(", ")} ${
    withheldYears.length > 1 ? "were" : "was"
  } withheld - a gap in season history corrupts recency-based avoidance. ${remedy}`;
}

// Plain-text schedule export shared by Step 3's Copy button and the shared
// schedule page's Copy Full Schedule. The body and Yahoo attribution are
// identical between the two views; only the heading prefix differs (Step 3
// always has a year, the share page may not), so callers compute and pass
// their own `headingPrefix` (with trailing blank line, or "" for none).
export function buildScheduleText(
  weeks: Matching[],
  teams: string[],
  platform: string | undefined,
  headingPrefix: string,
): string {
  const body = weeks
    .map(
      (week, wi) =>
        `Week ${wi + 1}\n` +
        week.map(([a, b]) => `  ${teams[a]}  vs  ${teams[b]}`).join("\n"),
    )
    .join("\n\n");
  const attribution =
    platform === "yahoo"
      ? "\n\nFantasy data provided by Yahoo Fantasy\nhttps://sports.yahoo.com/fantasy/"
      : "";
  return headingPrefix + body + attribution;
}
