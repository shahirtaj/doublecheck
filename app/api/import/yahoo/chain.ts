// The Yahoo import route's renew-chain walk, extracted with its fetches
// injected so the stop-condition logic is unit-testable without OAuth or
// Yahoo's nested JSON shapes (Next.js route files may only export route
// handlers). The route supplies fetchDetails (league metadata fetch + parse;
// throws on fetch errors, resolves null on unparseable responses) and
// fetchRecord (full season fetch; resolves null when the season yields no
// usable record).

import type { PairKey } from "@/lib/algorithm";

export type YahooLeagueMeta = {
  leagueKey: string;
  name: string;
  season: string;
  numTeams: number;
};

export type YahooLeagueDetails = YahooLeagueMeta & {
  startWeek: number;
  endWeek: number;
  playoffStartWeek: number;
  currentWeek: number;
  isFinished: boolean;
  renew: string | null;
};

export type ImportedSeasonRecord = {
  seasonYear: string;
  seasonName: string;
  teamNames: string[];
  userIds: (string | null)[];
  doubles: PairKey[];
  totalMatchups: number;
  regWeeks: number;
};

export type ChainDeps = {
  fetchDetails: (leagueKey: string) => Promise<YahooLeagueDetails | null>;
  fetchRecord: (
    details: YahooLeagueDetails,
  ) => Promise<ImportedSeasonRecord | null>;
};

// Walks the renew chain newest-first. Unlike the Sleeper/ESPN routes, which
// fetch seasons in parallel and report persistent per-season failures in a
// { seasons, failed } response, this walk is sequential and each link's
// `renew` pointer is the only way to reach the older seasons — so per-season
// failure tolerance doesn't fall out of the shape: a failed link can't be
// retried independently of the walk, and the seasons beyond it can't even be
// enumerated. Instead the route stays strict-but-contiguous: any mid-chain
// failure (fetch error, unparseable details, or a finished season yielding
// no record) stops the walk and returns the newer seasons collected so far.
// Truncated-but-contiguous history keeps the avoidance semantics over a
// shorter window; skipping the bad season and continuing would leave a gap
// that mis-ages every older season. A failure on the FIRST link still
// propagates so the route 502s as before — there's no partial to salvage.
export async function walkSeasonChain(
  startKey: string,
  seasonsCount: number,
  deps: ChainDeps,
): Promise<ImportedSeasonRecord[]> {
  const records: ImportedSeasonRecord[] = [];
  let currentKey: string | null = startKey;
  const seen = new Set<string>();

  for (
    let depth = 0;
    depth < seasonsCount && currentKey && records.length < seasonsCount;
    depth++
  ) {
    if (seen.has(currentKey)) break;
    seen.add(currentKey);

    let details: YahooLeagueDetails | null;
    try {
      details = await deps.fetchDetails(currentKey);
    } catch (e) {
      if ((e as Error).message === "UNAUTHORIZED" || records.length === 0) {
        throw e;
      }
      break;
    }
    if (!details) break;

    if (details.isFinished) {
      let record: ImportedSeasonRecord | null;
      try {
        record = await deps.fetchRecord(details);
      } catch (e) {
        if ((e as Error).message === "UNAUTHORIZED" || records.length === 0) {
          throw e;
        }
        break;
      }
      if (!record) break;
      records.push(record);
    }

    currentKey = details.renew;
  }

  return records;
}
