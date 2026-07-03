import { describeFormat, pairKey, unpackPairKey } from "@/lib/algorithm";
import type {
  LookbackWindow,
  Matching,
  PairKey,
  RivalryPin,
  ScheduleResult,
  SeasonHistory,
} from "@/lib/algorithm";
import { CURRENT_YEAR, MAX_IMPORT_SEASONS } from "./constants";
import type {
  FailedImportSeason,
  ImportPlatform,
  ImportedSeasonRecord,
  SelectedFormat,
} from "./types";
import type { State } from "./state";

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

// Cause-specific message for a failed format detection.
// detectFormatFromImport answers "is this schedulable?" with null; this
// names WHY, because the remedies differ and the old catch-all ("need an
// even team count and a regular-season week count") told an 8-team/15-week
// commissioner - whose league is real, just out of scope because some
// opponents play three times - nothing actionable. Week-count bounds reuse
// the algorithm validate() phrasing ("two full round-robins", "incomplete
// round-robins are not supported") so the two surfaces describe the same
// limits in the same words.
export function formatDetectionErrorMessage(
  season: ImportedSeasonRecord,
): string {
  const teamCount = season.teamNames?.length ?? 0;
  const weekCount = season.regWeeks ?? 0;
  const prefix = "Could not detect a valid league format -";
  if (teamCount === 0) {
    return `${prefix} the most recent season has no team data.`;
  }
  if (teamCount % 2 !== 0) {
    return `${prefix} the most recent season has ${teamCount} teams, and odd-sized leagues are not supported.`;
  }
  if (weekCount <= 0) {
    return `${prefix} the most recent season is missing a regular-season week count.`;
  }
  if (weekCount < teamCount - 1) {
    return `${prefix} a ${weekCount}-week regular season is shorter than a single round-robin for ${teamCount} teams (${teamCount - 1} weeks), and incomplete round-robins are not supported.`;
  }
  if (weekCount > 2 * (teamCount - 1)) {
    return `${prefix} a ${weekCount}-week regular season is longer than two full round-robins for ${teamCount} teams (${2 * (teamCount - 1)} weeks), so some opponents play three or more times. DoubleCheck only schedules each opponent once or twice.`;
  }
  // Unreachable when callers gate on a null detection; kept as a fallback so
  // a future caller can't render an empty message.
  return `${prefix} the most recent season's data is incomplete.`;
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
// Pinned matchups are the exception: they render in the order the pin was
// entered (teamA vs teamB) — each pin covers one appearance, matched by
// week when specific and claimed in week order when any-week, and the
// unpinned second leg of a naturally doubled 1-pin flips the entered order
// (the home-and-home convention). Forced orientations still feed the
// balance counters so the greedy compensates in the surrounding weeks,
// though a pinned team's split can land one off the exact 7/7.
export function computeDisplayWeeks(
  weeks: ReadonlyArray<Matching>,
  teams: ReadonlyArray<string>,
  rivalryPins: ReadonlyArray<RivalryPin> = [],
): [number, number][][] {
  type PinOrder = {
    teamA: number;
    teamB: number;
    week: number | null;
    used: boolean;
  };
  const pinsByPair = new Map<PairKey, PinOrder[]>();
  for (const p of rivalryPins) {
    const k = pairKey(p.teamA, p.teamB);
    const list = pinsByPair.get(k) ?? [];
    list.push({ teamA: p.teamA, teamB: p.teamB, week: p.week, used: false });
    pinsByPair.set(k, list);
  }

  const leftCount = new Array<number>(teams.length).fill(0);
  // NOTE: Order-dependent — leftCount is mutated during iteration so each
  // matchup's home/away assignment depends on assignments made in earlier
  // weeks. Do not parallelize or reorder.
  return weeks.map((week, weekIndex) => {
    const assigned: [number, number][] = week.map(([a, b]) => {
      const pinList = pinsByPair.get(pairKey(a, b));
      if (pinList) {
        const W = weekIndex + 1;
        let order: [number, number];
        const exact = pinList.find((p) => !p.used && p.week === W);
        const anyWeek =
          exact ?? pinList.find((p) => !p.used && p.week === null);
        if (anyWeek) {
          anyWeek.used = true;
          order = [anyWeek.teamA, anyWeek.teamB];
        } else {
          // The leg no pin covers (a 1-pin that naturally doubled):
          // home-and-home, whichever leg comes first.
          const ref = pinList[0]!;
          order = [ref.teamB, ref.teamA];
        }
        leftCount[order[0]]!++;
        return order;
      }
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

// Age of each prior season, keyed by season label - the same positional
// aging buildAvoidMap applies to priorSeasons(history, year), so the Season
// History list's HARD/SOFT/ROTATED OUT labels match what actually drives
// avoidance. Rows missing from the map (the in-progress season Save & Share
// records) drive no avoidance this year.
export function priorSeasonAges(
  history: readonly SeasonHistory[],
  year: number,
): Map<string, number> {
  const prior = priorSeasons(history, year);
  const ages = new Map<string, number>();
  prior.forEach((row, idx) => ages.set(row.season, prior.length - idx));
  return ages;
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

// Convert imported season records (oldest first) into history rows aligned
// with the freshly sorted roster. Rows prefer userid format - platform user
// IDs follow the manager across team renames. A pair whose member has no
// user ID can't be expressed in that format and is skipped at write time,
// openly - the same pairs resolveKey already discarded when older code wrote
// them as broken half-keys ("ABC:"), so effective avoidance is unchanged.
// Deliberately NOT demoted to whole-season index format when some IDs are
// missing: that would key EVERY pair by team name, trading the whole
// league's rename-proof records for the one ownerless team's - renames are
// routine in fantasy, ownerless slots are rare.
// Only seasons with NO user IDs at all (manual platforms, fully ownerless
// imports) use index format: each double's indices point into that season's
// own platform-ordered teamNames, so they're remapped by team name onto the
// sorted roster. Pairs naming teams no longer in the league can't be
// expressed as roster indices and are dropped - the same fate resolveKey
// gives departed users.
export function buildImportedHistoryRows(
  seasonsOldestFirst: readonly ImportedSeasonRecord[],
  sortedTeams: readonly string[],
): SeasonHistory[] {
  const indexByName = new Map<string, number>();
  sortedTeams.forEach((name, i) => indexByName.set(name, i));
  return seasonsOldestFirst.map((season) => {
    const sUserIds = season.userIds;
    const hasUids = sUserIds.some((id) => id != null);
    let doubles: PairKey[];
    if (hasUids) {
      doubles = season.doubles.flatMap((key) => {
        const [a, b] = unpackPairKey(key);
        const ua = sUserIds[a];
        const ub = sUserIds[b];
        return ua != null && ub != null ? [[ua, ub].sort().join(":")] : [];
      });
    } else {
      doubles = season.doubles.flatMap((key) => {
        const [a, b] = unpackPairKey(key);
        const i = indexByName.get(season.teamNames[a] ?? "");
        const j = indexByName.get(season.teamNames[b] ?? "");
        return i !== undefined && j !== undefined && i !== j
          ? [pairKey(i, j)]
          : [];
      });
    }
    return {
      season: season.seasonYear || String(CURRENT_YEAR - 1),
      doubles,
      format: hasUids ? "userid" : "index",
    };
  });
}

// True when the imported season's roster plausibly belongs to the league
// currently loaded. IDs are compared first when both sides have them - a
// disjoint ID set is a different league even if team names collide (two
// leagues full of default "Team N" names must not merge) - with shared team
// names as the fallback when either side has no IDs. Extends the import
// flow's formatChanged decision: a same-shape import of a DIFFERENT league
// must drop existing history exactly like a format change, or the old
// league's rows would silently feed the new league's avoidance. Same-league
// re-imports always share returning managers' IDs, so zero overlap means a
// league switch - or a roster so fully turned over that the old history
// couldn't be mapped onto it anyway; dropping is the safe answer both ways.
export function sharesRoster(
  teams: readonly string[],
  userIds: readonly (string | null)[],
  season: ImportedSeasonRecord,
): boolean {
  const currentIds = new Set(userIds.filter((id): id is string => id != null));
  const seasonIds = season.userIds.filter((id): id is string => id != null);
  if (currentIds.size > 0 && seasonIds.length > 0) {
    return seasonIds.some((id) => currentIds.has(id));
  }
  const names = new Set(teams);
  return season.teamNames.some((n) => names.has(n));
}

// Re-key index-format history rows that survive a same-league re-import.
// Index keys are positions in the roster array, and a re-import re-sorts the
// roster - a rename that changes the alphabetical order shifts every
// position after it, so surviving rows (manual Add Past Season entries,
// no-ID Save & Share rows) are remapped old position -> team name -> new
// position. Pairs whose team name is no longer in the new roster can't be
// expressed as roster indices and are dropped - same policy as
// buildImportedHistoryRows. userid rows pass through untouched (IDs don't
// care about positions), as do legacy ":" keys inside index rows (mirroring
// handleApplyLinkImport's remap tolerance).
export function remapIndexRowsByName(
  rows: readonly SeasonHistory[],
  oldTeams: readonly string[],
  newTeams: readonly string[],
): SeasonHistory[] {
  const newIndexByName = new Map<string, number>();
  newTeams.forEach((name, i) => newIndexByName.set(name, i));
  return rows.map((row) => {
    if (row.format === "userid") return row;
    return {
      ...row,
      doubles: (row.doubles ?? []).flatMap((key) => {
        if (key.indexOf(":") >= 0) return [key];
        const [a, b] = unpackPairKey(key);
        const i = newIndexByName.get(oldTeams[a] ?? "");
        const j = newIndexByName.get(oldTeams[b] ?? "");
        return i !== undefined && j !== undefined && i !== j
          ? [pairKey(i, j)]
          : [];
      }),
    };
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

// Size the ?seasons=N request for an import route. With a known format (a
// re-import - Back stashes it in priorFormat), right-size to the recommended
// lookback plus one for the newest season that anchors detection - for a
// mid-season Sleeper import that's the in-progress year, which doesn't count
// toward prior-season avoidance. Without one (a fresh import - the format is
// detected from the response), request enough for any supported format.
// Over-asking is safe: chain walks end at the league's real history, and
// extra ESPN years from before the league existed fail "not found" at the
// oldest edge, which withholdPreGapSeasons treats as no gap.
export function importSeasonsParam(format: SelectedFormat | null): number {
  if (!format) return MAX_IMPORT_SEASONS;
  const { lookback } = describeFormat(format.teamCount, format.weekCount);
  return Math.min(lookback.hard + lookback.soft + 1, MAX_IMPORT_SEASONS);
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

// Map the Yahoo OAuth callback's return params (?yahoo=connected, or
// ?yahoo=error&reason=...) to the state patch the landing effect applies;
// null for an unrecognized status. Both branches patch importSource
// alongside platform: OAuth is a full-page redirect, so importSource is
// back at its "sleeper" default, and the auto-load fetch's stale() guard
// checks importSourceRef at response time - without this the response is
// discarded and the UI hangs on the loading status.
export function yahooOAuthReturnPatch(
  params: URLSearchParams,
): Partial<State> | null {
  const status = params.get("yahoo");
  const reason = params.get("reason");
  if (status === "connected") {
    // pendingYahooConnect bridges to fetchYahooLeagues, which lives inside
    // ImportSections — that component picks up the flag and runs the fetch.
    return {
      platform: "yahoo",
      importSource: "yahoo",
      pendingYahooConnect: true,
    };
  }
  if (status === "error") {
    return {
      platform: "yahoo",
      importSource: "yahoo",
      importStatus: "error",
      // The reason is either a snake_case OAuth code (state_mismatch) or an
      // Error message. "Failed to <verb>: <detail>" appends no period of its
      // own - an Error-message reason keeps the one it arrives with.
      importMsg: `Failed to connect to Yahoo Fantasy: ${(
        reason || "unknown"
      ).replace(/_/g, " ")}`,
    };
  }
  return null;
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

// Paint-anchored yield. A bare setTimeout(0) usually fires before the next
// rendering opportunity, so it would NOT reliably let the caller's
// "Generating…" state paint before the next synchronous attempt blocks the
// main thread; requestAnimationFrame runs in the rendering steps, and the
// nested timeout resumes after the paint. The backstop covers hidden tabs,
// where rAF doesn't fire and the run would otherwise stall until the tab is
// foregrounded (a resolved promise ignores the late second resolve).
const paintYield = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    const backstop = setTimeout(resolve, 100);
    requestAnimationFrame(() => {
      clearTimeout(backstop);
      setTimeout(resolve, 0);
    });
  });

// Runs `attempt` until it succeeds, fails for a non-retryable reason, the
// attempt/wall-clock budget is spent, or `shouldStop` reports the run was
// superseded. Generation is stochastic: a "generation-failed" result
// usually means the random search missed, not that no schedule exists -
// probes put tight-but-satisfiable pin configurations at ~20-25% success
// per attempt with 65-250ms failures, so a couple of seconds of retries
// turns "usually fails" into "essentially always works". The other failure
// reasons (format skips, invalid-format) are deterministic and return after
// one attempt; deterministic generation-failed cases (structurally
// impossible pin sets) burn the budget, but they fail fast and the attempt
// cap bounds them. The yield runs BEFORE every attempt - including the
// first, so the caller's just-patched in-progress state can paint before
// the synchronous main-thread work starts. `now` and `yieldToUi` are
// injectable for node tests.
export async function generateWithRetry(
  attempt: () => ScheduleResult,
  budgetMs: number,
  maxAttempts: number,
  opts: {
    shouldStop?: () => boolean;
    now?: () => number;
    yieldToUi?: () => Promise<void>;
  } = {},
): Promise<{ result: ScheduleResult; attempts: number }> {
  const now = opts.now ?? (() => performance.now());
  const yieldToUi = opts.yieldToUi ?? paintYield;
  const shouldStop = opts.shouldStop ?? (() => false);
  const start = now();
  let attempts = 0;
  let result: ScheduleResult;
  do {
    await yieldToUi();
    result = attempt();
    attempts++;
  } while (
    !result.ok &&
    result.reason === "generation-failed" &&
    result.retryable &&
    attempts < maxAttempts &&
    now() - start < budgetMs &&
    !shouldStop()
  );
  return { result, attempts };
}

// Cap check for adding a rivalry pin. Only a pair's SECOND pin forces a
// double (a 1-pin means "at least one game": block-area 1-pins try the
// natural double but fall back to a single when they must), so the per-team
// cap counts opponents from 2-pinned pairs only. The old form counted every
// pinned opponent, refusing e.g. three locked single rivalry games for one
// team in a two-double format - a feasible, reasonable request. Anything
// infeasible the looser form admits is rejected instantly and
// deterministically at Generate time (resolvePins, retryable: false).
// Returns null when the pin is allowed; fires only for a pair's second pin
// (a pair already at its pin cap is the pairAtMax check's job, keeping that
// message's more specific wording).
export function pinDoubleCapError(
  rivalryPins: ReadonlyArray<RivalryPin>,
  teamA: number,
  teamB: number,
  teams: ReadonlyArray<string>,
  doublesPerTeam: number,
): string | null {
  const pairCounts = new Map<PairKey, number>();
  for (const p of rivalryPins) {
    const k = pairKey(p.teamA, p.teamB);
    pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
  }
  const thisKey = pairKey(teamA, teamB);
  if ((pairCounts.get(thisKey) ?? 0) !== 1) return null;
  const doubledOpponents = (team: number): number => {
    let n = 0;
    for (const [k, c] of pairCounts) {
      if (c < 2 || k === thisKey) continue;
      const [a, b] = unpackPairKey(k);
      if (a === team || b === team) n++;
    }
    return n;
  };
  for (const team of [teamA, teamB]) {
    const n = doubledOpponents(team);
    if (n >= doublesPerTeam) {
      return `${teams[team]} already has ${n} repeat opponent${n === 1 ? "" : "s"} pinned - this format supports at most ${doublesPerTeam} per team.`;
    }
  }
  return null;
}

// Copy for the over-avoided degree proof (overAvoidedTeams, lib/algorithm):
// the one failure class we can name exactly, so the message names the teams
// and counts instead of generic remedies. Two variants share the first
// sentence: `remedies` builds the pre-Generate error (bare-imperative
// remedy sentence naming only the controls that exist - manual avoids,
// the Lookback Window when it's rendered and above zero, Season History
// when prior seasons exist); null builds the live matrix warning.
export function overAvoidedMessage(
  entries: ReadonlyArray<{ team: number; avoided: number }>,
  teams: ReadonlyArray<string>,
  teamCount: number,
  doublesPerTeam: number,
  remedies: {
    hasManualAvoids: boolean;
    canShrinkLookback: boolean;
    hasPriorSeasons: boolean;
  } | null,
): string {
  const maxAvoidable = teamCount - 1 - doublesPerTeam;
  const cause = `(each team must double ${doublesPerTeam} of its ${teamCount - 1} opponents)`;
  let detail: string;
  if (entries.length === 1) {
    const e = entries[0]!;
    detail = `${teams[e.team]} has ${e.avoided} hard-avoided opponent${e.avoided === 1 ? "" : "s"} - this format allows at most ${maxAvoidable} ${cause}.`;
  } else {
    const names = entries.map((e) => teams[e.team]);
    const list =
      names.length === 2
        ? names.join(" and ")
        : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
    detail = `${list} have too many hard-avoided opponents - this format allows at most ${maxAvoidable} per team ${cause}.`;
  }
  if (remedies === null) {
    return `${detail} Generating will fail until some are removed.`;
  }
  const options: string[] = [];
  if (remedies.hasManualAvoids) options.push("clear some manual avoids");
  if (remedies.canShrinkLookback) options.push("shrink the Lookback Window");
  if (remedies.hasPriorSeasons)
    options.push("edit the doubles recorded in Season History");
  // Over-avoidance requires avoids, which only come from the matrix or
  // history, so at least one remedy always applies.
  const list =
    options.length <= 2
      ? options.join(" or ")
      : `${options.slice(0, -1).join(", ")}, or ${options[options.length - 1]}`;
  const remedy = list.charAt(0).toUpperCase() + list.slice(1);
  return `${detail} ${remedy}.`;
}

// The constraint sources that can bind a failed generation, as the caller
// sees them. The client can't tell which one actually bound (pins, manual
// avoids, and lookback-derived doubles all feed the same search), so the
// message names every control that exists - and only those: pointing a user
// at "manual avoids" they never set, or a Lookback Window control that isn't
// rendered (it hides without prior seasons), is worse than the old bias of
// always naming pins first.
export type GenerationRemedies = {
  hasPins: boolean;
  hasManualAvoids: boolean;
  // True when the Step 2 Lookback Window control is visible and above zero
  // (page.tsx's effectiveLookbackTotal > 0). Shrinking only relieves the
  // search once it cuts into the hard window, but the control is still the
  // right pointer - the same advice the no-pins copy always gave.
  canShrinkLookback: boolean;
};

// User-facing message for a failed generation, written for the post-retry
// world: a retryable failure only renders after generateWithRetry burned its
// budget, so "try generating again" is honest advice (a fresh click buys a
// whole new batch of attempts) and the constraint remedies cover the truly
// infeasible case - the two are indistinguishable once the search has
// missed that many times. Pins lead the remedy list when present (the most
// likely binding constraint), but every applicable control is named - a
// user may well prefer dropping an avoid or a season of lookback over a
// rivalry pin.
export function generationFailureMessage(
  result: Extract<ScheduleResult, { ok: false }>,
  remedies: GenerationRemedies,
): string {
  // Format skips and invalid-format carry their own definitive messages.
  if (result.reason !== "generation-failed") return result.message;
  // Deterministic failures (pin validation, pin placement conflicts) return
  // identically on every attempt, so the retry loop stopped after one try
  // and "try generating again" would be false advice - the algorithm's own
  // message is definitive and never advises retrying.
  if (!result.retryable) return result.message;
  // Sequenced, not a flat menu: the structure encodes what we actually
  // know. A fresh click buys a whole new batch of attempts and usually
  // suffices (the unlucky case); constraint removal is what to suspect
  // only when repeated clicks keep failing (the infeasible-beyond-our-
  // proofs case) - and repeated failure is also exactly the signal that
  // separates the two from the user's seat.
  const base =
    "Could not generate a valid schedule after several attempts. Try generating again.";
  const escalations: string[] = [];
  if (remedies.hasPins) escalations.push("removing some rivalry pins");
  if (remedies.hasManualAvoids) escalations.push("clearing some manual avoids");
  if (remedies.canShrinkLookback)
    escalations.push("shrinking the Lookback Window");
  if (escalations.length === 0) return base;
  const list =
    escalations.length <= 2
      ? escalations.join(" or ")
      : `${escalations.slice(0, -1).join(", ")}, or ${escalations[escalations.length - 1]}`;
  return `${base} If it keeps failing, try ${list}.`;
}
