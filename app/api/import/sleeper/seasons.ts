// Settlement logic for the Sleeper import route's per-season fetches: fetch
// every target concurrently, re-attempt failures once, and classify the
// outcome into successful season records and per-season failures. Lives in a
// sibling module (Next.js route files may only export route handlers) with
// the fetch injected so the classification is unit-testable without network.

export type SeasonTarget = {
  leagueId: string;
  name: string;
  season: string;
  settings?: { playoff_week_start?: number };
};

export type SeasonData = {
  teamNames: string[];
  userIds: (string | null)[];
  doubles: string[];
  totalMatchups: number;
  regWeeks: number;
};

export type SeasonResult = SeasonData & {
  seasonYear: string;
  seasonName: string;
};

export type FailedSeason = { season: string; error: string };

// One entry of the username-lookup league picker, plus the renewal pointer
// the merge needs (stripped before the response - the client picker only
// renders leagueId/name/season).
export type LeagueYearEntry = {
  leagueId: string;
  name: string;
  season: string;
  previousLeagueId: string | null;
};

// Merge a user's current-year and prior-year league lists for the picker.
// Leagues renew independently across the June-September window, so during
// the offseason a user's leagues are SPLIT across two years: renewed ones
// under the new season, not-yet-renewed ones still under last season. The
// old first-non-empty-year lookup made one renewal hide every unrenewed
// league (a two-league user saw only the renewed league, auto-selected).
// Rule: every current-year league, plus each prior-year league that no
// current-year league supersedes via previous_league_id (the renewed
// league's prior edition would otherwise appear twice). Sorted season
// descending then name ascending with numeric compare - the same order the
// Yahoo picker uses.
export function mergeLeagueYears(
  currentYear: LeagueYearEntry[],
  priorYear: LeagueYearEntry[],
): Array<{ leagueId: string; name: string; season: string }> {
  const superseded = new Set(
    currentYear
      .map((l) => l.previousLeagueId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const merged = [
    ...currentYear,
    ...priorYear.filter((l) => !superseded.has(l.leagueId)),
  ];
  return merged
    .map(({ leagueId, name, season }) => ({ leagueId, name, season }))
    .sort((a, b) => {
      const bySeason = b.season.localeCompare(a.season, undefined, {
        numeric: true,
      });
      return bySeason !== 0
        ? bySeason
        : a.name.localeCompare(b.name, undefined, { numeric: true });
    });
}

export type SettledSeasons = {
  results: SeasonResult[];
  failed: FailedSeason[];
  errors: string[];
};

// Fetch seasons concurrently and tolerate per-season failures: one dead
// season (e.g. a deleted league mid-chain) shouldn't 502 the seasons that
// did load. allSettled preserves input order, so the response stays
// most-recent-first regardless of which fetch finishes when.
export async function settleSeasonFetches(
  toFetch: SeasonTarget[],
  fetchOne: (target: SeasonTarget) => Promise<SeasonData>,
): Promise<SettledSeasons> {
  const settled = await Promise.allSettled(
    toFetch.map((target) => fetchOne(target)),
  );

  // Most per-season failures are transient, so one immediate re-attempt
  // over just the rejected seasons makes the partial path rare rather than
  // routine. No backoff machinery — the route already runs long and the
  // serverless time budget is finite.
  const rejectedIdx = settled
    .map((result, i) => (result.status === "rejected" ? i : -1))
    .filter((i) => i >= 0);
  if (rejectedIdx.length > 0) {
    const retried = await Promise.allSettled(
      rejectedIdx.map((i) => fetchOne(toFetch[i]!)),
    );
    retried.forEach((result, j) => {
      settled[rejectedIdx[j]!] = result;
    });
  }

  const results: SeasonResult[] = [];
  // Seasons that failed both attempts. `season` stays the year label (not
  // the leagueId fallback used in the 502 message) so the client can tell
  // WHICH attempted years are missing and withhold the seasons older than
  // the gap — client-side year arithmetic would wrongly truncate leagues
  // that genuinely skipped a year.
  const failed: FailedSeason[] = [];
  const errors: string[] = [];

  settled.forEach((result, i) => {
    const target = toFetch[i]!;
    if (result.status === "fulfilled") {
      const data = result.value;
      results.push({
        seasonYear: target.season,
        seasonName: target.name,
        teamNames: data.teamNames,
        userIds: data.userIds,
        doubles: data.doubles,
        totalMatchups: data.totalMatchups,
        regWeeks: data.regWeeks,
      });
    } else {
      const msg =
        result.reason instanceof Error
          ? result.reason.message
          : typeof result.reason === "string"
            ? result.reason
            : "unknown error";
      failed.push({ season: target.season, error: msg });
      // Trailing period stripped: the route joins these with " | " and adds
      // its own terminal period, so a kept period would double up.
      errors.push(
        `${target.season || target.leagueId}: ${msg.replace(/\.$/, "")}`,
      );
    }
  });

  return { results, failed, errors };
}
