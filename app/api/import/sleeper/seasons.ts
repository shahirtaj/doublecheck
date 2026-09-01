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

// A league as the renewal resolver sees it: its ID plus the backward
// renewal pointer ("0"/empty already normalized to null by the fetchers).
export type ResolveCandidate = {
  leagueId: string;
  previousLeagueId: string | null;
};

// Find the current edition of a league whose stored ID may be seasons old.
// Sleeper league IDs change on renewal and previous_league_id only points
// backward, so the successor has to come from a manager's league lists:
// every (userId, year) pair is listed, and the league whose renewal chain
// contains `renewFrom` wins. Resolution order:
//   1. Direct match - a candidate's previous_league_id IS renewFrom (the
//      common next-season restore). Checked across all lists first so the
//      renewed edition beats renewFrom itself appearing in an older list.
//   2. renewFrom itself still listed - the league hasn't renewed; it IS the
//      current edition.
//   3. Chain walk - a candidate's chain reaches renewFrom in 2+ hops (the
//      link is several seasons old), bounded by `chainFetchBudget` total
//      fetchLeague calls. A fetch failure or "0" terminator just ends that
//      candidate's walk.
//   4. No match - return renewFrom. The stored league still exists on
//      Sleeper, so importing it yields the newest data these managers can
//      reach (not renewed, or renewed under managers we weren't given).
// Per-listing failures are tolerated (a deleted account shouldn't kill
// resolution), but if EVERY listing fails the resolver throws - falling
// back to renewFrom then would silently import a stale league during an
// outage that the caller should surface instead.
export async function resolveRenewedLeague(
  renewFrom: string,
  userIds: readonly string[],
  years: readonly number[],
  listLeagues: (userId: string, year: number) => Promise<ResolveCandidate[]>,
  fetchLeague: (leagueId: string) => Promise<ResolveCandidate | null>,
  chainFetchBudget = 10,
): Promise<string> {
  const candidates: ResolveCandidate[] = [];
  const seen = new Set<string>();
  let listingsSucceeded = 0;
  let lastListingError: unknown = null;
  for (const userId of userIds) {
    for (const year of years) {
      let leagues: ResolveCandidate[];
      try {
        leagues = await listLeagues(userId, year);
      } catch (e) {
        lastListingError = e;
        continue;
      }
      listingsSucceeded++;
      for (const league of leagues) {
        if (!league.leagueId || seen.has(league.leagueId)) continue;
        seen.add(league.leagueId);
        candidates.push(league);
      }
    }
  }
  if (listingsSucceeded === 0 && userIds.length > 0) {
    throw lastListingError instanceof Error
      ? lastListingError
      : new Error("Could not list leagues for any saved manager.");
  }

  const isChainEnd = (id: string | null): id is null =>
    id === null || id === "" || id === "0";

  for (const candidate of candidates) {
    if (candidate.previousLeagueId === renewFrom) return candidate.leagueId;
  }
  if (seen.has(renewFrom)) return renewFrom;

  let budget = chainFetchBudget;
  const walked = new Set<string>();
  for (const candidate of candidates) {
    let prev = isChainEnd(candidate.previousLeagueId)
      ? null
      : candidate.previousLeagueId;
    while (prev !== null && budget > 0) {
      // Chains can converge (co-managers listing the same league lineage);
      // a visited link means some earlier candidate already walked past it
      // without finding renewFrom.
      if (walked.has(prev)) break;
      walked.add(prev);
      budget--;
      let link: ResolveCandidate | null;
      try {
        link = await fetchLeague(prev);
      } catch {
        break;
      }
      if (!link) break;
      if (link.previousLeagueId === renewFrom) return candidate.leagueId;
      prev = isChainEnd(link.previousLeagueId) ? null : link.previousLeagueId;
    }
  }
  return renewFrom;
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
