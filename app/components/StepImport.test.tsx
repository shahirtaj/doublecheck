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
import { ImportSections } from "./StepImport";

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
        recommendedLookbackTotal={3}
      />
    );
  }

  render(<Harness />);
  return {
    getState: () => current,
    platformRef,
    importSourceRef,
    saveToStorage,
  };
}

function importedSeason(year: string, teamCount = 10): ImportedSeasonRecord {
  return {
    seasonYear: year,
    seasonName: "Test League",
    teamNames: Array.from({ length: teamCount }, (_, i) => `Team ${i + 1}`),
    userIds: Array.from({ length: teamCount }, () => null),
    doubles: [],
    regWeeks: 13,
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
