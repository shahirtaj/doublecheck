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
      errors.push(`${target.season || target.leagueId}: ${msg}`);
    }
  });

  return { results, failed, errors };
}
