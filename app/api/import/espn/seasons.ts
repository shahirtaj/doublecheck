// Settlement logic for the ESPN import route's per-season fetches: fetch
// every requested year concurrently, re-attempt retryable failures once, and
// classify the outcome into successful season records and per-season
// failures. Lives in a sibling module (Next.js route files may only export
// route handlers) with the fetch injected so the retry classification is
// unit-testable without network.

export type FailedSeason = { season: string; error: string };

// Deterministic failure classes. Anything else a fetch throws (network,
// 5xx, malformed body) is treated as transient and retried once.
export type EspnFailureKind = "private" | "not-found";

// Thrown by the per-season fetch for the deterministic statuses so
// settlement classifies on the kind, not on message text - a message that
// merely mentions "not found" must not skip the retry.
export class EspnSeasonError extends Error {
  readonly kind: EspnFailureKind;

  constructor(message: string, kind: EspnFailureKind) {
    super(message);
    this.name = "EspnSeasonError";
    this.kind = kind;
  }
}

function failureKind(reason: unknown): EspnFailureKind | "transient" {
  return reason instanceof EspnSeasonError ? reason.kind : "transient";
}

export type SettledEspnSeasons<T> = {
  results: T[];
  failed: FailedSeason[];
  errors: string[];
  // True when nothing succeeded, every failure was a deterministic
  // private/not-found status, and at least one was private - the route
  // surfaces that as a clean 403 (or 401 on the cookie path) instead of a
  // 502 dump. Mixed private + not-found stays private: a young private
  // league 404s its pre-creation years, and the cookie remedy still applies.
  allPrivate: boolean;
  // True when nothing succeeded and EVERY failure was not-found - a wrong or
  // nonexistent league ID, where the private-league remedies would mislead.
  allNotFound: boolean;
};

export async function settleEspnSeasons<T>(
  years: number[],
  fetchOne: (year: number) => Promise<T>,
): Promise<SettledEspnSeasons<T>> {
  const settled = await Promise.allSettled(years.map((year) => fetchOne(year)));

  // Most per-season failures are transient, so one immediate re-attempt
  // over just the rejected seasons makes the partial path rare rather than
  // routine (no backoff — the serverless time budget is finite). Private
  // and not-found failures come from deterministic HTTP statuses, so
  // retrying them would only double the request count for the common
  // private-league and young-league cases.
  const retryIdx = settled
    .map((result, i) => {
      if (result.status !== "rejected") return -1;
      return failureKind(result.reason) === "transient" ? i : -1;
    })
    .filter((i) => i >= 0);
  if (retryIdx.length > 0) {
    const retried = await Promise.allSettled(
      retryIdx.map((i) => fetchOne(years[i]!)),
    );
    retried.forEach((result, j) => {
      settled[retryIdx[j]!] = result;
    });
  }

  const results: T[] = [];
  // Seasons that failed both attempts, by year label, so the client can
  // tell WHICH attempted years are missing and withhold the seasons older
  // than the gap — client-side year arithmetic would wrongly truncate
  // leagues that genuinely skipped a year.
  const failed: FailedSeason[] = [];
  const errors: string[] = [];
  let sawPrivate = false;
  let allDeterministic = true;
  let allNotFound = true;

  settled.forEach((result, i) => {
    const year = years[i]!;
    if (result.status === "fulfilled") {
      results.push(result.value);
    } else {
      const msg =
        result.reason instanceof Error
          ? result.reason.message
          : typeof result.reason === "string"
            ? result.reason
            : "unknown error";
      const kind = failureKind(result.reason);
      const isPrivate = kind === "private";
      const isNotFound = kind === "not-found";
      if (isPrivate) sawPrivate = true;
      if (!isPrivate && !isNotFound) allDeterministic = false;
      if (!isNotFound) allNotFound = false;
      failed.push({ season: String(year), error: msg });
      // Trailing period stripped: the route joins these with " | " and adds
      // its own terminal period, so a kept period would double up.
      errors.push(`${year}: ${msg.replace(/\.$/, "")}`);
    }
  });

  const nothingSucceeded = results.length === 0 && failed.length > 0;
  return {
    results,
    failed,
    errors,
    allPrivate: nothingSucceeded && allDeterministic && sawPrivate,
    allNotFound: nothingSucceeded && allNotFound,
  };
}
