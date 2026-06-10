import { describe, expect, it } from "vitest";
import { settleEspnSeasons } from "./seasons";

type SeasonStub = { seasonYear: string };

function privateError(year: number): Error {
  return new Error(`Season ${year} is private. Public leagues only for now.`);
}

function notFoundError(year: number): Error {
  return new Error(`Season ${year} not found for this league.`);
}

// Builds a fetcher whose behavior is scripted per year: a number N fails the
// first N calls with a transient error, an Error instance fails every call
// with that error. Records per-year call counts.
function scriptedFetcher(script: Record<number, number | Error>) {
  const calls: Record<number, number> = {};
  const fetchOne = async (year: number): Promise<SeasonStub> => {
    calls[year] = (calls[year] ?? 0) + 1;
    const rule = script[year];
    if (rule instanceof Error) throw rule;
    if ((rule ?? 0) >= calls[year]!) {
      throw new Error(`Network error fetching season ${year}: socket reset.`);
    }
    return { seasonYear: String(year) };
  };
  return { fetchOne, calls };
}

describe("settleEspnSeasons", () => {
  it("passes through full success in input order", async () => {
    const { fetchOne, calls } = scriptedFetcher({});

    const { results, failed, errors, allPrivate } = await settleEspnSeasons(
      [2025, 2024],
      fetchOne,
    );

    expect(results.map((r) => r.seasonYear)).toEqual(["2025", "2024"]);
    expect(failed).toEqual([]);
    expect(errors).toEqual([]);
    expect(allPrivate).toBe(false);
    expect(calls).toEqual({ 2025: 1, 2024: 1 });
  });

  it("retries a transient failure once and recovery leaves no failed entry", async () => {
    const { fetchOne, calls } = scriptedFetcher({ 2024: 1 });

    const { results, failed, allPrivate } = await settleEspnSeasons(
      [2025, 2024],
      fetchOne,
    );

    expect(results.map((r) => r.seasonYear)).toEqual(["2025", "2024"]);
    expect(failed).toEqual([]);
    expect(allPrivate).toBe(false);
    expect(calls).toEqual({ 2025: 1, 2024: 2 });
  });

  it("does not retry private failures and flags allPrivate when nothing else succeeded", async () => {
    const { fetchOne, calls } = scriptedFetcher({
      2025: privateError(2025),
      2024: privateError(2024),
    });

    const { results, failed, allPrivate } = await settleEspnSeasons(
      [2025, 2024],
      fetchOne,
    );

    expect(results).toEqual([]);
    expect(failed.map((f) => f.season)).toEqual(["2025", "2024"]);
    expect(allPrivate).toBe(true);
    // Deterministic statuses get exactly one attempt.
    expect(calls).toEqual({ 2025: 1, 2024: 1 });
  });

  it("does not retry not-found failures", async () => {
    const { fetchOne, calls } = scriptedFetcher({ 2021: notFoundError(2021) });

    const { results, failed } = await settleEspnSeasons([2022, 2021], fetchOne);

    expect(results.map((r) => r.seasonYear)).toEqual(["2022"]);
    expect(failed).toEqual([
      { season: "2021", error: "Season 2021 not found for this league." },
    ]);
    expect(calls).toEqual({ 2022: 1, 2021: 1 });
  });

  it("reports a both-attempts transient failure under the year label", async () => {
    const { fetchOne, calls } = scriptedFetcher({ 2023: 2 });

    const { results, failed, errors, allPrivate } = await settleEspnSeasons(
      [2024, 2023],
      fetchOne,
    );

    expect(results.map((r) => r.seasonYear)).toEqual(["2024"]);
    expect(failed).toEqual([
      {
        season: "2023",
        error: "Network error fetching season 2023: socket reset.",
      },
    ]);
    expect(errors).toEqual([
      "2023: Network error fetching season 2023: socket reset.",
    ]);
    expect(allPrivate).toBe(false);
    expect(calls).toEqual({ 2024: 1, 2023: 2 });
  });

  it("classifies a mixed outcome: success, unretried private, retried transient", async () => {
    const { fetchOne, calls } = scriptedFetcher({
      2024: privateError(2024),
      2023: 1,
    });

    const { results, failed, allPrivate } = await settleEspnSeasons(
      [2025, 2024, 2023],
      fetchOne,
    );

    expect(results.map((r) => r.seasonYear)).toEqual(["2025", "2023"]);
    expect(failed.map((f) => f.season)).toEqual(["2024"]);
    expect(allPrivate).toBe(false);
    expect(calls).toEqual({ 2025: 1, 2024: 1, 2023: 2 });
  });
});
