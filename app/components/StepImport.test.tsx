// @vitest-environment jsdom
import { useCallback, useState } from "react";
import type { MutableRefObject } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type State } from "./state";
import type {
  ImportPlatform,
  ImportSource,
  ImportedSeasonRecord,
} from "./types";
import { ImportSections, StepImport } from "./StepImport";

// Minimal stateful stand-in for page.tsx: useState owns State, patch is a
// merging setState (so effects and re-renders behave as in the app), the
// platform/source refs are plain objects the test mutates directly to
// simulate mid-flight dropdown switches, and saveToStorage is a spy.
function renderImportSections(seed: Partial<State>) {
  const platformRef = {
    current: seed.platform ?? initialState.platform,
  } as MutableRefObject<ImportPlatform>;
  const importSourceRef = {
    current: seed.importSource ?? initialState.importSource,
  } as MutableRefObject<ImportSource>;
  const importSeqRef = { current: 0 } as MutableRefObject<number>;
  const saveToStorage = vi.fn();
  let current: State = { ...initialState, ...seed };

  function Harness() {
    const [state, setState] = useState<State>(current);
    const patch = useCallback(
      (p: Partial<State>) => setState((prev) => ({ ...prev, ...p })),
      [],
    );
    current = state;
    return (
      <ImportSections
        state={state}
        patch={patch}
        saveToStorage={saveToStorage}
        platformRef={platformRef}
        importSourceRef={importSourceRef}
        importSeqRef={importSeqRef}
      />
    );
  }

  render(<Harness />);
  return {
    getState: () => current,
    platformRef,
    importSourceRef,
    importSeqRef,
    saveToStorage,
  };
}

function importedSeason(
  year: string,
  teamCount = 10,
  regWeeks = 13,
): ImportedSeasonRecord {
  return {
    seasonYear: year,
    seasonName: "Test League",
    teamNames: Array.from({ length: teamCount }, (_, i) => `Team ${i + 1}`),
    userIds: Array.from({ length: teamCount }, () => null),
    doubles: [],
    regWeeks,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

// Vitest runs without globals, so testing-library can't auto-register its
// cleanup - do it explicitly alongside the fetch unstub.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("withholding warning render", () => {
  const partialSleeperImport = () =>
    jsonResponse({
      seasons: [
        importedSeason("2025"),
        importedSeason("2024"),
        importedSeason("2022"),
      ],
      failed: [{ season: "2023", error: "HTTP 502" }],
    });
  const warningText =
    "2023 failed to import, so 2022 was withheld - a gap in season history corrupts recency-based avoidance. Retry the import, or add 2023 via Add Past Season and re-import.";

  it("renders the amber warning in the preview card on a partial import", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(partialSleeperImport()));
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));

    const warning = await screen.findByText(warningText);
    expect(warning).toHaveClass("text-amber-400");
    // Only the seasons newer than the gap reach the preview.
    expect(screen.getByText("2 seasons: 2025, 2024")).toBeInTheDocument();
    expect(h.getState().importStatus).toBe("ready");
  });

  it("clears the status and message when the preview is cancelled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(partialSleeperImport()));
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText(warningText);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(h.getState().importPreview).toBeNull();
    expect(h.getState().importStatus).toBe("");
    expect(h.getState().importMsg).toBe("");
    // The warning must not leak into the next view's message area.
    expect(screen.queryByText(warningText)).not.toBeInTheDocument();
  });
});

describe("import request sizing", () => {
  // The wiring is what regresses here, not the math (importSeasonsParam owns
  // the math and is tested in utils.test.ts): the old prop-threaded value was
  // 0 by construction at the production call site, so every import silently
  // fell back to the server default of 5 seasons.
  it("requests the works-for-any-format maximum on a fresh import", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([importedSeason("2025")]));
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(h.getState().importStatus).toBe("ready"));

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/import/sleeper?seasons=14");
  });

  it("right-sizes to the stashed format's lookback on a re-import after Back", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([importedSeason("2025"), importedSeason("2024")]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
      priorFormat: { teamCount: 10, weekCount: 13 },
      teams: Array.from({ length: 10 }, (_, i) => `Team ${i + 1}`),
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(h.getState().importStatus).toBe("ready"));

    // 10/13: hard 1 + soft 1 prior seasons, + 1 for the anchor season.
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/import/sleeper?seasons=3");
  });

  it("refetches once at the detected size when the league's shape outgrew the baseline", async () => {
    // Re-import sized to priorFormat (10/13 -> seasons=3), but the response
    // is a 14/14 league wanting 14 - and the request was the binding
    // constraint (3 returned for 3 asked), so more history may exist. The
    // client must refetch at the detected size instead of silently landing
    // with a 3-season avoidance window.
    const fourteen = (years: string[]) =>
      jsonResponse(years.map((y) => importedSeason(y, 14, 14)));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fourteen(["2025", "2024", "2023"]))
      .mockResolvedValueOnce(
        fourteen(["2025", "2024", "2023", "2022", "2021"]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
      priorFormat: { teamCount: 10, weekCount: 13 },
      teams: Array.from({ length: 10 }, (_, i) => `Team ${i + 1}`),
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText("5 seasons: 2025, 2024, 2023, 2022, 2021");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/import/sleeper?seasons=3");
    // 14/14: hard 12 + soft 1 priors, + 1 anchor.
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/import/sleeper?seasons=14");
    expect(h.getState().importPreview?.seasons).toHaveLength(5);
  });

  it("does not refetch when the league has less history than was requested", async () => {
    // Same shape change, but only 2 seasons came back for 3 asked - the
    // league is exhausted (e.g. it just expanded to 14 teams), so a larger
    // request can't return more. One fetch, preview as-is.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          importedSeason("2025", 14, 14),
          importedSeason("2024", 14, 14),
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
      priorFormat: { teamCount: 10, weekCount: 13 },
      teams: Array.from({ length: 10 }, (_, i) => `Team ${i + 1}`),
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText("2 seasons: 2025, 2024");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the first response when the right-size refetch fails", async () => {
    // The first response was valid, just possibly short - a failed refetch
    // must not turn a working import into an error (the pre-refetch
    // behavior is the floor).
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          importedSeason("2025", 14, 14),
          importedSeason("2024", 14, 14),
          importedSeason("2023", 14, 14),
        ]),
      )
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
      priorFormat: { teamCount: 10, weekCount: 13 },
      teams: Array.from({ length: 10 }, (_, i) => `Team ${i + 1}`),
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText("3 seasons: 2025, 2024, 2023");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.getState().importStatus).toBe("ready");
  });

  it("discards the fallback when the request is superseded during a rejected refetch", async () => {
    // The refetch's catch follows awaits, so it must run the stale check
    // before falling back - otherwise an abandoned request's first response
    // lands in shared state, overwriting whatever the superseding request
    // is doing (last-request-wins would silently break).
    let rejectRefetch!: (e: Error) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          importedSeason("2025", 14, 14),
          importedSeason("2024", 14, 14),
          importedSeason("2023", 14, 14),
        ]),
      )
      .mockReturnValueOnce(
        new Promise<Response>((_, reject) => {
          rejectRefetch = reject;
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
      priorFormat: { teamCount: 10, weekCount: 13 },
      teams: Array.from({ length: 10 }, (_, i) => `Team ${i + 1}`),
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // A newer fetch claims the next sequence number while the refetch is
    // still in flight, then the refetch dies.
    h.importSeqRef.current++;
    rejectRefetch(new Error("network down"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.getState().importPreview).toBeNull();
    expect(h.getState().importStatus).toBe("loading");
  });

  it("falls back to the first response when the refetch returns an unusable body", async () => {
    // A 200 whose body fails preview (here: empty seasons) must not turn a
    // working import into an error - the first response is the floor for
    // every refetch failure shape, not just rejections.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          importedSeason("2025", 14, 14),
          importedSeason("2024", 14, 14),
          importedSeason("2023", 14, 14),
        ]),
      )
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
      priorFormat: { teamCount: 10, weekCount: 13 },
      teams: Array.from({ length: 10 }, (_, i) => `Team ${i + 1}`),
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText("3 seasons: 2025, 2024, 2023");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.getState().importStatus).toBe("ready");
  });
});

describe("re-import after Back", () => {
  // Back clears selectedFormat (that's what re-enters the import UI) but
  // stashes it in priorFormat, so these seeds mirror the post-Back state of
  // a league whose teams/history are still loaded.
  const teams = Array.from({ length: 10 }, (_, i) => `Team ${i + 1}`);

  it("merges into existing history when the imported shape matches priorFormat", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          seasons: [importedSeason("2025"), importedSeason("2024")],
          failed: [{ season: "2023", error: "HTTP 502" }],
        }),
      ),
    );
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
      priorFormat: { teamCount: 10, weekCount: 13 },
      teams,
      history: [{ season: "2023", doubles: ["0-1"], format: "index" }],
      lookbackOverride: 2,
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText("2 seasons: 2025, 2024");
    // The failed 2023 fetch is not a gap: the existing manual row fills it,
    // so nothing is withheld and no warning renders.
    expect(h.getState().importMsg).toBe("");

    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(h.getState().history.map((r) => r.season)).toEqual([
      "2023",
      "2024",
      "2025",
    ]);
    expect(h.getState().history[0]!.doubles).toEqual(["0-1"]);
    expect(h.getState().selectedFormat).toEqual({
      teamCount: 10,
      weekCount: 13,
    });
    expect(h.getState().priorFormat).toBeNull();
    expect(h.getState().lookbackOverride).toBe(2);
  });

  it("clears pins, avoids, the armed remove confirm, and the persisted lists on apply", async () => {
    // Apply replaces the pin list, so the armed per-row Remove confirm must
    // disarm (it would re-arm on whatever pin lands at that index next) and
    // the cleared lists must ride the saveToStorage extras - the patch hasn't
    // flushed at save time, so the closure still sees the old pins and
    // manual avoids.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([importedSeason("2025"), importedSeason("2024")]),
        ),
    );
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
      priorFormat: { teamCount: 10, weekCount: 13 },
      teams: Array.from({ length: 10 }, (_, i) => `Team ${i + 1}`),
      rivalryPins: [{ teamA: 0, teamB: 1, week: 3 }],
      manualDoubles: new Set(["2-5"]),
      confirmRemovePinIndex: 0,
      // The Yahoo OAuth return path hydrates a stored "doubles" before the
      // auto-import applies - the gate must drop back to name verification.
      furthestStep: "doubles",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText("2 seasons: 2025, 2024");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(h.getState().rivalryPins).toEqual([]);
    expect(h.getState().manualDoubles.size).toBe(0);
    expect(h.getState().confirmRemovePinIndex).toBeNull();
    // The patch hasn't flushed at save time, so the cleared pins, the
    // cleared manual avoids, and the Step 1 landing must ride the extras
    // (a stale persisted step would make the next reload skip name
    // verification; stale avoids would resurrect index pairs that may point
    // at the wrong teams after a re-sort or league switch).
    expect(h.saveToStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        rivalryPins: [],
        manualDoubles: [],
        step: "teams",
      }),
    );
    expect(h.getState().step).toBe("teams");
    expect(h.getState().furthestStep).toBe("teams");
  });

  it("drops existing history when a same-shape import shares no roster member", async () => {
    // A commissioner of two leagues imports league B over league A without
    // Reset: same shape, but zero roster overlap (different names, no IDs).
    // League A's rows must not feed league B's avoidance.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([importedSeason("2025"), importedSeason("2024")]),
        ),
    );
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
      priorFormat: { teamCount: 10, weekCount: 13 },
      teams: Array.from({ length: 10 }, (_, i) => `Other ${i + 1}`),
      history: [{ season: "2023", doubles: ["0-1"], format: "index" }],
      lookbackOverride: 2,
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText("2 seasons: 2025, 2024");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(h.getState().history.map((r) => r.season)).toEqual(["2024", "2025"]);
    expect(h.getState().lookbackOverride).toBeNull();
  });

  it("drops existing history and the lookback override on a format change", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([importedSeason("2025"), importedSeason("2024")]),
        ),
    );
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
      priorFormat: { teamCount: 12, weekCount: 14 },
      teams: Array.from({ length: 12 }, (_, i) => `Team ${i + 1}`),
      history: [{ season: "2023", doubles: ["0-1"], format: "index" }],
      lookbackOverride: 2,
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText("2 seasons: 2025, 2024");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(h.getState().history.map((r) => r.season)).toEqual(["2024", "2025"]);
    expect(h.getState().selectedFormat).toEqual({
      teamCount: 10,
      weekCount: 13,
    });
    expect(h.getState().lookbackOverride).toBeNull();
  });
});

describe("link restore format bounds", () => {
  it("rejects a restored format outside the round-robin range", async () => {
    // Links predating the server validator's format bounds could carry an
    // unschedulable shape; the client must refuse it rather than restore a
    // format that misrenders or fails generation.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          format: { teamCount: 8, weekCount: 15 },
          teams: Array.from({ length: 8 }, (_, i) => `Team ${i + 1}`),
          userIds: Array.from({ length: 8 }, () => null),
        }),
      ),
    );
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "link",
      shareLinkInput: "https://doublecheckff.com/s/abc12345",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));

    await waitFor(() => expect(h.getState().importStatus).toBe("error"));
    expect(h.getState().importMsg).toBe(
      "This share link has an invalid format.",
    );
    expect(h.getState().linkPreview).toBeNull();
  });
});

describe("manual import", () => {
  it("disables out-of-range week options with a hint and clamps the selection", async () => {
    const h = renderImportSections({
      platform: "manual",
      importSource: "manual",
      manualTeamCount: 12,
      manualWeekCount: 15,
    });
    const user = userEvent.setup();

    // 12 teams: every week option is in range.
    expect(screen.getByRole("option", { name: "15 weeks" })).toBeEnabled();

    await user.selectOptions(screen.getByDisplayValue("12 teams"), "8");

    // 8 teams caps at 2*(8-1) = 14 weeks: the selection clamps to 14, and
    // the 15-week option stays visible but disabled - 8/15 leagues exist on
    // platforms (a third matchup), they're just outside DoubleCheck's scope,
    // so the option teaches the limit instead of vanishing.
    expect(h.getState().manualWeekCount).toBe(14);
    expect(
      screen.getByRole("option", { name: "15 weeks (needs 10+ teams)" }),
    ).toBeDisabled();
  });
});

describe("Yahoo OAuth pending-connect hand-off", () => {
  it("fires the leagues fetch and renders the picker on success", async () => {
    const leagues = [
      { leagueKey: "nfl.l.1", name: "League A", season: "2025", numTeams: 10 },
      { leagueKey: "nfl.l.2", name: "League B", season: "2025", numTeams: 10 },
      { leagueKey: "nfl.l.3", name: "League C", season: "2025", numTeams: 10 },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ leagues }));
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "yahoo",
      importSource: "yahoo",
      pendingYahooConnect: true,
    });

    expect(
      await screen.findByText("Found 3 Yahoo Fantasy leagues - pick one."),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/import/yahoo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(h.getState().pendingYahooConnect).toBe(false);
    expect(
      screen.getByRole("button", { name: "Use this league" }),
    ).toBeInTheDocument();
  });

  it("renders the Connect button with status cleared on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Not connected." }, 401)),
    );
    const h = renderImportSections({
      platform: "yahoo",
      importSource: "yahoo",
      pendingYahooConnect: true,
    });

    const connect = await screen.findByRole("button", {
      name: "Connect to Yahoo Fantasy",
    });
    await waitFor(() => expect(h.getState().importStatus).toBe(""));
    expect(connect).toBeEnabled();
    expect(h.getState().importMsg).toBe("");
    expect(h.getState().yahooLeagues).toBeNull();
  });
});

describe("stale-response guards", () => {
  it("discards a Sleeper response after the platform switches to ESPN", async () => {
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      ),
    );
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    expect(h.getState().importStatus).toBe("loading");

    // The user switches the dropdown to ESPN while the request is in flight.
    h.platformRef.current = "espn";
    h.importSourceRef.current = "espn";
    resolveFetch(
      jsonResponse([importedSeason("2025"), importedSeason("2024")]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The response must not land: no preview, no status/message patch.
    expect(h.getState().importPreview).toBeNull();
    expect(h.getState().importStatus).toBe("loading");
    expect(h.getState().importMsg).toBe("Fetching season data from Sleeper…");
  });

  it("discards a response superseded by a newer fetch on the same platform", async () => {
    // Two in-flight Sleeper fetches (a typo'd league ID corrected and
    // refetched) have identical platform and source values, so only the
    // request counter can tell them apart - without it the slow first
    // response lands last and wins.
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      ),
    );
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    // A second fetch claims the next sequence number while the first is
    // still in flight.
    h.importSeqRef.current++;
    resolveFetch(
      jsonResponse([importedSeason("2025"), importedSeason("2024")]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.getState().importPreview).toBeNull();
    expect(h.getState().importStatus).toBe("loading");
  });

  it("discards a response after an A-B-A platform round trip", async () => {
    // sleeper -> espn -> sleeper restores the ref VALUES the request was
    // started for, so the value-equality checks pass; the dropdown bumps
    // the sequence counter on every switch, which is what catches this.
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      ),
    );
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    // The user round-trips the dropdown; the refs land back on "sleeper"
    // but each switch bumps the counter (simulated here the same way the
    // other ref mutations are).
    h.importSeqRef.current++;
    h.importSeqRef.current++;
    resolveFetch(
      jsonResponse([importedSeason("2025"), importedSeason("2024")]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.getState().importPreview).toBeNull();
    expect(h.getState().importStatus).toBe("loading");
  });

  it("discards a link restore response after the source switches away from link", async () => {
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      ),
    );
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "link",
      shareLinkInput: "https://doublecheckff.com/s/abc12345",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    expect(h.getState().importStatus).toBe("loading");
    expect(h.getState().importMsg).toBe("Fetching shared league…");

    // Switching off "Restore from link" leaves platform unchanged by
    // design, so only the source ref flips - the race a platform check
    // alone could never catch.
    h.importSourceRef.current = "sleeper";
    resolveFetch(
      jsonResponse({
        format: { teamCount: 10, weekCount: 13 },
        teams: Array.from({ length: 10 }, (_, i) => `Team ${i + 1}`),
        userIds: Array.from({ length: 10 }, () => null),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.getState().linkPreview).toBeNull();
    expect(h.getState().importStatus).toBe("loading");
  });
});

describe("one-click re-import (pendingSourceReimport)", () => {
  it("resolves a Sleeper source ID and previews the resolved league", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ leagueId: "900" }))
      .mockResolvedValueOnce(jsonResponse([importedSeason("2026")]));
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      sourceLeagueId: "800",
      leagueId: "800",
      userIds: ["111", null, "222"],
      priorFormat: { teamCount: 10, weekCount: 13 },
      pendingSourceReimport: true,
    });

    await waitFor(() => expect(h.getState().importStatus).toBe("ready"));
    expect(h.getState().pendingSourceReimport).toBe(false);
    // Resolution first, carrying the stored ID and only the non-null
    // manager IDs (the forward path to the renewed league).
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/import/sleeper");
    expect(
      JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string),
    ).toEqual({ renewFrom: "800", userIds: ["111", "222"] });
    // The seasons fetch and the visible input both use the resolved ID.
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/import/sleeper?seasons=3");
    expect(
      JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string),
    ).toEqual({ leagueId: "900" });
    expect(h.getState().leagueId).toBe("900");
    expect(h.getState().importPreview?.sourceLeagueId).toBe("900");
  });

  it("fetches ESPN directly with the stored ID - ESPN IDs are stable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([importedSeason("2026")]));
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "espn",
      importSource: "espn",
      sourceLeagueId: "555",
      leagueId: "555",
      priorFormat: { teamCount: 10, weekCount: 13 },
      pendingSourceReimport: true,
    });

    await waitFor(() => expect(h.getState().importStatus).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/import/espn?seasons=3");
    expect(
      JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string),
    ).toEqual({ leagueId: "555" });
    expect(h.getState().importPreview?.sourceLeagueId).toBe("555");
  });

  it("surfaces a resolution failure instead of importing the stale league", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "Failed to find the renewed Sleeper league: HTTP 503" },
          502,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      sourceLeagueId: "800",
      userIds: ["111"],
      pendingSourceReimport: true,
    });

    await waitFor(() => expect(h.getState().importStatus).toBe("error"));
    // No follow-up seasons fetch - a silently stale import would defeat
    // the whole point of the shortcut.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.getState().importMsg).toBe(
      "Failed to find the renewed Sleeper league: HTTP 503",
    );
  });

  it("Apply records the fetched ID as sourceLeagueId, riding the save extras", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse([importedSeason("2026")])),
    );
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "sleeper",
      leagueId: "123456789",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText("1 season: 2026");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(h.getState().sourceLeagueId).toBe("123456789");
    expect(h.saveToStorage).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLeagueId: "123456789" }),
    );
  });

  it("restores sourceLeagueId from a share payload on link apply", async () => {
    const h = renderImportSections({
      platform: "sleeper",
      importSource: "link",
      linkPreview: {
        format: { teamCount: 4, weekCount: 3 },
        teams: ["A", "B", "C", "D"],
        userIds: [null, null, null, null],
        platform: "sleeper",
        sourceLeagueId: "800",
      },
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(h.getState().sourceLeagueId).toBe("800");
    expect(h.saveToStorage).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLeagueId: "800" }),
    );
  });

  it("drops a restored sourceLeagueId when the platform falls back to manual", async () => {
    // Older links (and crafted payloads) can pair an ID with a platform
    // that can't re-import; the shortcut must not render off it.
    const h = renderImportSections({
      platform: "manual",
      importSource: "link",
      linkPreview: {
        format: { teamCount: 4, weekCount: 3 },
        teams: ["A", "B", "C", "D"],
        userIds: [null, null, null, null],
        sourceLeagueId: "800",
      },
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(h.getState().sourceLeagueId).toBeNull();
  });
});

describe("Step 1 re-import shortcut", () => {
  const stepOrder = ["teams", "doubles", "schedule"] as const;

  function renderStepOne(seed: Partial<State>) {
    const onReimport = vi.fn();
    render(
      <StepImport
        state={{ ...initialState, ...seed }}
        patch={vi.fn()}
        saveToStorage={vi.fn()}
        stepOrder={stepOrder}
        onReimport={onReimport}
      />,
    );
    return { onReimport };
  }

  it("offers the re-import button for a synced league with a stored ID", async () => {
    const { onReimport } = renderStepOne({
      teams: ["A", "B", "C", "D"],
      platform: "sleeper",
      sourceLeagueId: "800",
    });
    const user = userEvent.setup();

    await user.click(
      screen.getByRole("button", { name: "Re-import from Sleeper" }),
    );
    expect(onReimport).toHaveBeenCalledTimes(1);
  });

  it("keeps the nudge but points at Back when no ID is stored", () => {
    // Pre-sourceLeagueId links and stored states are exactly the users the
    // stale-roster nudge exists for - only the one-click button needs the ID.
    renderStepOne({ teams: ["A", "B", "C", "D"], platform: "sleeper" });
    expect(
      screen.queryByRole("button", { name: /^Re-import from/ }),
    ).toBeNull();
    expect(
      screen.getByText(/Re-import via Back to pick up this season's roster/),
    ).toBeInTheDocument();
  });

  it("shows neither the nudge nor the button for manual leagues", () => {
    renderStepOne({
      teams: ["A", "B", "C", "D"],
      platform: "manual",
      sourceLeagueId: "800",
    });
    expect(
      screen.queryByRole("button", { name: /^Re-import from/ }),
    ).toBeNull();
    expect(screen.queryByText(/Names come from your last import/)).toBeNull();
  });
});

describe("ESPN cookie section", () => {
  const PRIVATE_MESSAGE =
    "This ESPN league is private. Import it with your espn_s2 cookie, or use Manual import.";
  const REJECTED_MESSAGE =
    "ESPN rejected the cookie for every season. Check that espn_s2 was copied completely, and that the signed-in ESPN account was in this league during those seasons.";
  const MASK_CLASS = "[-webkit-text-security:disc]";

  function requestBody(call: unknown[]): unknown {
    return JSON.parse((call[1] as RequestInit).body as string);
  }

  it("opens on the private 403, sends the pasted cookie, and clears the prompt on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: PRIVATE_MESSAGE, code: "private" }, 403),
      )
      .mockResolvedValueOnce(
        jsonResponse([importedSeason("2025"), importedSeason("2024")]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "espn",
      importSource: "espn",
      leagueId: "123456789",
    });
    const user = userEvent.setup();

    // Nothing asks for a cookie until the route does.
    expect(screen.queryByText("ESPN Cookie")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(h.getState().importStatus).toBe("error"));
    // The anonymous request carries no cookie key at all.
    expect(requestBody(fetchMock.mock.calls[0]!)).toEqual({
      leagueId: "123456789",
    });
    expect(h.getState().espnAuthCode).toBe("private");
    expect(screen.getByText(PRIVATE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText("ESPN Cookie")).toBeInTheDocument();
    expect(screen.getByText(/never stores it\./)).toBeInTheDocument();
    expect(
      screen.getByText(/Making the league public on ESPN opens only/),
    ).toBeInTheDocument();
    const fetchWithCookie = screen.getByRole("button", {
      name: "Fetch with cookie",
    });
    expect(fetchWithCookie).toBeDisabled();

    await user.type(screen.getByLabelText("espn_s2 cookie"), "AEBcookie");
    // Typing clears the error line but the prompt stays open.
    expect(h.getState().importStatus).toBe("");
    expect(screen.getByText("ESPN Cookie")).toBeInTheDocument();
    expect(fetchWithCookie).toBeEnabled();

    await user.click(fetchWithCookie);
    await waitFor(() => expect(h.getState().importStatus).toBe("ready"));
    expect(requestBody(fetchMock.mock.calls[1]!)).toEqual({
      leagueId: "123456789",
      espnS2: "AEBcookie",
    });
    expect(h.getState().espnAuthCode).toBeNull();
    // Retained for the visit so a same-session re-import needs no re-paste.
    expect(h.getState().espnS2).toBe("AEBcookie");
  });

  it("keeps the section and the cookie on a cookies-rejected 401, without the public-toggle hint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: REJECTED_MESSAGE, code: "cookies-rejected" },
          401,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "espn",
      importSource: "espn",
      leagueId: "123456789",
      espnS2: "AEBwrong",
    });
    const user = userEvent.setup();

    // A retained cookie keeps the section visible (and editable) with the
    // short note in place of the paste instructions.
    expect(screen.getByText("ESPN Cookie")).toBeInTheDocument();
    expect(
      screen.getByText(/Clear the field to import without it\./),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Fetch with cookie" }));
    await waitFor(() => expect(h.getState().importStatus).toBe("error"));
    expect(requestBody(fetchMock.mock.calls[0]!)).toEqual({
      leagueId: "123456789",
      espnS2: "AEBwrong",
    });
    expect(h.getState().espnAuthCode).toBe("cookies-rejected");
    expect(h.getState().espnS2).toBe("AEBwrong");
    expect(screen.getByText(REJECTED_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(/never stores it\./)).toBeInTheDocument();
    expect(screen.queryByText(/without a cookie\./)).toBeNull();
  });

  it("sends the retained cookie on a one-click re-import", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([importedSeason("2026")]));
    vi.stubGlobal("fetch", fetchMock);
    const h = renderImportSections({
      platform: "espn",
      importSource: "espn",
      sourceLeagueId: "555",
      leagueId: "555",
      priorFormat: { teamCount: 10, weekCount: 13 },
      pendingSourceReimport: true,
      espnS2: "AEBcookie",
    });

    await waitFor(() => expect(h.getState().importStatus).toBe("ready"));
    expect(requestBody(fetchMock.mock.calls[0]!)).toEqual({
      leagueId: "555",
      espnS2: "AEBcookie",
    });
  });

  it("closes the prompt when a later response carries no auth code", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: 'ESPN league "123456789" not found. Check the league ID.',
            },
            404,
          ),
        ),
    );
    const h = renderImportSections({
      platform: "espn",
      importSource: "espn",
      leagueId: "123456789",
      espnAuthCode: "private",
    });
    const user = userEvent.setup();
    expect(screen.getByText("ESPN Cookie")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(h.getState().importStatus).toBe("error"));
    expect(h.getState().espnAuthCode).toBeNull();
    expect(screen.queryByText("ESPN Cookie")).toBeNull();
  });

  it("ignores an auth code on a response the stale guard discards", async () => {
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      ),
    );
    const h = renderImportSections({
      platform: "espn",
      importSource: "espn",
      leagueId: "123456789",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    h.platformRef.current = "sleeper";
    h.importSourceRef.current = "sleeper";
    resolveFetch(
      jsonResponse({ error: PRIVATE_MESSAGE, code: "private" }, 403),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.getState().espnAuthCode).toBeNull();
    expect(screen.queryByText("ESPN Cookie")).toBeNull();
  });

  it("drops the cookie and the prompt when the dropdown leaves ESPN", async () => {
    const h = renderImportSections({
      platform: "espn",
      importSource: "espn",
      leagueId: "123456789",
      espnS2: "AEBcookie",
      espnAuthCode: "private",
      espnS2Visible: true,
    });
    const user = userEvent.setup();
    expect(screen.getByText("ESPN Cookie")).toBeInTheDocument();

    await user.selectOptions(screen.getByDisplayValue("ESPN"), "sleeper");
    expect(h.getState().espnS2).toBe("");
    expect(h.getState().espnAuthCode).toBeNull();
    expect(h.getState().espnS2Visible).toBe(false);
    expect(screen.queryByText("ESPN Cookie")).toBeNull();
  });

  it("masks the cookie as a plain text field and reveals it on Show", async () => {
    renderImportSections({
      platform: "espn",
      importSource: "espn",
      leagueId: "123456789",
      espnS2: "AEBcookie",
    });
    const user = userEvent.setup();
    const input = screen.getByLabelText("espn_s2 cookie");

    // Not type="password": browsers would offer to save the cookie.
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveClass(MASK_CLASS);

    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(input).not.toHaveClass(MASK_CLASS);
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(input).toHaveClass(MASK_CLASS);
  });
});
