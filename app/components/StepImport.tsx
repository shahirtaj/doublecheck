"use client";

import { useEffect, type ChangeEvent, type MutableRefObject } from "react";
import {
  pairKey,
  unpackPairKey,
  type PairKey,
  type RivalryPin,
  type SeasonHistory,
} from "@/lib/algorithm";
import { cls, statusToneClass } from "./styles";
import type {
  ImportPlatform,
  ImportSource,
  ImportedSeasonRecord,
  SelectedFormat,
  SleeperLeagueOption,
  YahooLeagueOption,
} from "./types";
import { detectFormatFromImport, extractSlug, platformLabel } from "./utils";
import type { Patch, SaveToStorageFn, State } from "./state";

type ImportSectionsProps = {
  state: State;
  patch: Patch;
  saveToStorage: SaveToStorageFn;
  platformRef: MutableRefObject<ImportPlatform>;
  recommendedLookbackTotal: number;
};

// Filter imported seasons down to the format detected from the most recent
// season. Older seasons with a different roster size are dropped because
// their team-index space wouldn't line up with the detected format.
function filterToDetectedFormat(seasons: ImportedSeasonRecord[]): {
  detected: SelectedFormat;
  seasons: ImportedSeasonRecord[];
} | null {
  const detected = detectFormatFromImport(seasons[0]!);
  if (!detected) return null;
  const filtered = seasons.filter(
    (s) => s.teamNames?.length === detected.teamCount,
  );
  return { detected, seasons: filtered };
}

export function ImportSections(props: ImportSectionsProps) {
  const { state, patch, saveToStorage, platformRef, recommendedLookbackTotal } =
    props;
  const {
    platform,
    importSource,
    leagueId,
    shareLinkInput,
    importStatus,
    importMsg,
    importHelpUrl,
    importPreview,
    linkPreview,
    yahooLeagues,
    selectedYahooLeague,
    sleeperLeagues,
    selectedSleeperLeague,
    manualLeagueName,
    manualTeamCount,
    manualWeekCount,
    selectedFormat,
    history,
    pendingYahooConnect,
  } = state;

  const importBusy = importStatus === "loading";

  function resetImportUi() {
    patch({
      importPreview: null,
      linkPreview: null,
      shareLinkInput: "",
      importStatus: "",
      importMsg: "",
      sleeperLeagues: null,
      selectedSleeperLeague: "",
    });
  }

  async function handleFetch() {
    const input = leagueId.trim();
    if (!input) return;
    patch({
      importPreview: null,
      sleeperLeagues: null,
      selectedSleeperLeague: "",
    });

    // Sleeper accepts either a numeric league ID (existing chain flow) or a
    // username (look up user → list current-year leagues → picker). ESPN only
    // accepts league IDs.
    if (platform === "sleeper" && !/^\d+$/.test(input)) {
      patch({
        importStatus: "loading",
        importMsg: `Looking up Sleeper user "${input}"…`,
      });
      try {
        const res = await fetch("/api/import/sleeper", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: input }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        const leagues = (data?.leagues || []) as SleeperLeagueOption[];
        if (leagues.length === 0) {
          throw new Error("No Sleeper NFL leagues found for this user.");
        }
        if (leagues.length === 1) {
          patch({
            sleeperLeagues: leagues,
            selectedSleeperLeague: leagues[0]!.leagueId,
          });
          await fetchSleeperLeagueSeasons(leagues[0]!.leagueId);
          return;
        }
        patch({
          sleeperLeagues: leagues,
          importStatus: "",
          importMsg: `Found ${leagues.length} Sleeper leagues - pick one.`,
        });
      } catch (e) {
        patch({
          importStatus: "error",
          importMsg: (e as Error).message || "Sleeper username lookup failed.",
        });
      }
      return;
    }

    patch({
      importStatus: "loading",
      importMsg: `Fetching from ${platformLabel(platform)}…`,
    });
    try {
      const res = await fetch(
        `/api/import/${platform}?seasons=${recommendedLookbackTotal}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leagueId: input }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        if (typeof data?.helpUrl === "string")
          patch({ importHelpUrl: data.helpUrl });
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const seasons = data as ImportedSeasonRecord[];
      if (!Array.isArray(seasons) || seasons.length === 0) {
        throw new Error("No seasons returned.");
      }
      const detected = filterToDetectedFormat(seasons);
      if (!detected) {
        throw new Error(
          "Could not detect a valid league format from the most recent season (need an even team count and a regular-season week count).",
        );
      }
      patch({
        importPreview: { platform, seasons: detected.seasons },
        importStatus: "ready",
        importMsg: "",
      });
    } catch (e) {
      patch({
        importStatus: "error",
        importMsg: (e as Error).message || "Fetch failed.",
      });
    }
  }

  async function fetchSleeperLeagueSeasons(specificLeagueId: string) {
    patch({
      importStatus: "loading",
      importMsg: "Loading season data from Sleeper…",
      importPreview: null,
    });
    try {
      const res = await fetch(
        `/api/import/sleeper?seasons=${recommendedLookbackTotal}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leagueId: specificLeagueId }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const seasons = data as ImportedSeasonRecord[];
      if (!Array.isArray(seasons) || seasons.length === 0) {
        throw new Error("No seasons returned.");
      }
      const detected = filterToDetectedFormat(seasons);
      if (!detected) {
        throw new Error(
          "Could not detect a valid league format from the most recent season (need an even team count and a regular-season week count).",
        );
      }
      patch({
        importPreview: { platform: "sleeper", seasons: detected.seasons },
        importStatus: "ready",
        importMsg: "",
      });
    } catch (e) {
      patch({
        importStatus: "error",
        importMsg: (e as Error).message || "Fetch failed.",
      });
    }
  }

  // Yahoo helpers ─ separate from handleFetch because the flow is two-step:
  // first list the user's leagues (no body), then fetch a chosen league's
  // season chain (with leagueKey). 401 means the user hasn't gone through
  // OAuth yet (or their refresh token expired); the UI shows Connect Yahoo.

  async function fetchYahooLeagueSeasons(leagueKey: string) {
    patch({
      importStatus: "loading",
      importMsg: "Loading season data from Yahoo Fantasy…",
      importPreview: null,
    });
    try {
      const res = await fetch(
        `/api/import/yahoo?seasons=${recommendedLookbackTotal}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leagueKey }),
        },
      );
      if (platformRef.current !== "yahoo") return;
      const data = await res.json();
      if (platformRef.current !== "yahoo") return;
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const seasons = data as ImportedSeasonRecord[];
      if (!Array.isArray(seasons) || seasons.length === 0) {
        throw new Error("No seasons returned.");
      }
      const detected = filterToDetectedFormat(seasons);
      if (!detected) {
        throw new Error(
          "Could not detect a valid league format from the most recent season (need an even team count and a regular-season week count).",
        );
      }
      patch({
        importPreview: { platform: "yahoo", seasons: detected.seasons },
        importStatus: "ready",
        importMsg: "",
      });
    } catch (e) {
      if (platformRef.current !== "yahoo") return;
      patch({
        importStatus: "error",
        importMsg: (e as Error).message || "Fetch failed.",
      });
    }
  }

  async function fetchYahooLeagues() {
    patch({
      importStatus: "loading",
      importMsg: "Loading Yahoo Fantasy leagues…",
      yahooLeagues: null,
      selectedYahooLeague: "",
      importPreview: null,
    });
    try {
      const res = await fetch("/api/import/yahoo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (platformRef.current !== "yahoo") return;
      if (res.status === 401) {
        // Treated as "not connected" — clear status so the Connect Yahoo
        // button shows. The user will run through OAuth to get a token.
        patch({
          yahooLeagues: null,
          importStatus: "",
          importMsg: "",
        });
        return;
      }
      const data = await res.json();
      if (platformRef.current !== "yahoo") return;
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const leagues = (data?.leagues || []) as YahooLeagueOption[];
      patch({ yahooLeagues: leagues });
      if (leagues.length === 0) {
        patch({
          importStatus: "error",
          importMsg: "No football leagues found on your Yahoo Fantasy account.",
        });
        return;
      }
      if (leagues.length === 1) {
        patch({ selectedYahooLeague: leagues[0]!.leagueKey });
        await fetchYahooLeagueSeasons(leagues[0]!.leagueKey);
        return;
      }
      patch({
        importStatus: "",
        importMsg: `Found ${leagues.length} Yahoo Fantasy leagues - pick one.`,
      });
    } catch (e) {
      if (platformRef.current !== "yahoo") return;
      patch({
        importStatus: "error",
        importMsg:
          (e as Error).message || "Failed to load Yahoo Fantasy leagues.",
      });
    }
  }

  // OAuth callback hand-off. page.tsx flips pendingYahooConnect on return from
  // the Yahoo OAuth flow; we pick that up here and run the leagues fetch.
  useEffect(() => {
    if (!pendingYahooConnect) return;
    patch({ pendingYahooConnect: false });
    void fetchYahooLeagues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingYahooConnect]);

  // Clear the ESPN private-league help link as soon as the status moves out of
  // error so a fresh attempt doesn't render stale guidance.
  useEffect(() => {
    if (importStatus !== "error") patch({ importHelpUrl: null });
  }, [importStatus, patch]);

  function handleApplyImport() {
    if (!importPreview || importPreview.seasons.length === 0) return;
    const mostRecent = importPreview.seasons[0]!;
    const detected = detectFormatFromImport(mostRecent);
    if (!detected) return;

    // Reimport always replaces the roster with the imported names; fresh
    // data wins over any local edits. A format change additionally resets
    // selectedFormat and the lookback override and drops the prior history
    // (handled below) since its team indices belong to a different roster.
    const formatChanged =
      !selectedFormat ||
      selectedFormat.teamCount !== detected.teamCount ||
      selectedFormat.weekCount !== detected.weekCount;

    let nextTeams: string[] = mostRecent.teamNames;
    let nextUserIds: (string | null)[] = mostRecent.userIds;

    // Sort teams and userIds together by team name so index 0 is always
    // the alphabetically-first team from the moment of import. Indices
    // are assigned once, here — all downstream logic (algorithm, matrix,
    // storage) stays consistent with that assignment.
    const sortedPairs = nextTeams
      .map((name, i) => ({ name, userId: nextUserIds[i] ?? null }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    nextTeams = sortedPairs.map((p) => p.name);
    nextUserIds = sortedPairs.map((p) => p.userId);

    // Server returns most-recent-first; history stores oldest-first. When the
    // format changes we drop existing history because its team indices belong
    // to a different roster size.
    const seasonsOldestFirst = [...importPreview.seasons].reverse();
    const newHistory: SeasonHistory[] = formatChanged ? [] : [...history];
    for (const season of seasonsOldestFirst) {
      const sUserIds = season.userIds;
      const hasUids = sUserIds.some((id) => id != null);
      let importDoubles: PairKey[];
      if (hasUids) {
        importDoubles = season.doubles.map((key) => {
          const [a, b] = unpackPairKey(key);
          return [sUserIds[a], sUserIds[b]].sort().join(":");
        });
      } else {
        importDoubles = season.doubles;
      }

      const candidateYear =
        season.seasonYear || String(new Date().getFullYear() - 1);
      const candidateDoublesStr = [...importDoubles].sort().join(",");
      const isDuplicate = newHistory.some(
        (entry) =>
          entry.season === candidateYear &&
          [...entry.doubles].sort().join(",") === candidateDoublesStr,
      );
      if (!isDuplicate) {
        newHistory.push({
          season: candidateYear,
          doubles: importDoubles,
          format: hasUids ? "userid" : "index",
        });
      }
    }

    // Adopt the most recent season's league name. The Yahoo picker, ESPN's
    // settings.name, and Sleeper's league.name all flow through seasonName.
    const nextLeagueName = (mostRecent.seasonName || "").trim();

    patch({
      ...(formatChanged
        ? { selectedFormat: detected, lookbackOverride: null }
        : {}),
      teams: nextTeams,
      userIds: nextUserIds,
      history: newHistory,
      ...(nextLeagueName ? { leagueName: nextLeagueName } : {}),
      manualDoubles: new Set(),
      rivalryPins: [],
      pinTeamA: 0,
      pinTeamB: 1,
      pinWeek: null,
    });

    saveToStorage({
      history: newHistory,
      teams: nextTeams,
      userIds: nextUserIds,
      format: detected,
      ...(nextLeagueName ? { leagueName: nextLeagueName } : {}),
      ...(formatChanged ? { lookbackOverride: null } : {}),
    });
  }

  async function handleFetchLink() {
    const slug = extractSlug(shareLinkInput);
    if (!slug) {
      patch({
        importStatus: "error",
        importMsg:
          "That doesn't look like a DoubleCheck share link. Paste the full URL or the 8-character slug.",
      });
      return;
    }
    patch({
      importStatus: "loading",
      importMsg: "Fetching shared league…",
      linkPreview: null,
    });
    try {
      const res = await fetch(`/api/share/${slug}`);
      const raw = await res.json();
      if (!res.ok) throw new Error(raw?.error || `HTTP ${res.status}`);
      if (
        !raw ||
        typeof raw !== "object" ||
        !raw.format ||
        !Array.isArray(raw.teams) ||
        !Array.isArray(raw.userIds) ||
        raw.teams.length !== raw.userIds.length
      ) {
        throw new Error("This share link is missing required league data.");
      }
      const payload = raw as {
        format: { teamCount: number; weekCount: number };
        teams: string[];
        userIds: (string | null)[];
        leagueName?: string;
        platform?: string;
        history?: SeasonHistory[];
        manualDoubles?: PairKey[];
        rivalryPins?: RivalryPin[];
      };
      if (
        typeof payload.format.teamCount !== "number" ||
        typeof payload.format.weekCount !== "number"
      ) {
        throw new Error("This share link has an invalid format.");
      }
      patch({
        linkPreview: {
          format: payload.format,
          teams: payload.teams,
          userIds: payload.userIds,
          leagueName: payload.leagueName,
          platform: payload.platform,
          history: payload.history,
          manualDoubles: payload.manualDoubles,
          rivalryPins: payload.rivalryPins,
        },
        importStatus: "ready",
        importMsg: "",
      });
    } catch (e) {
      patch({
        importStatus: "error",
        importMsg: (e as Error).message || "Could not fetch this share link.",
      });
    }
  }

  // Apply step for the link-import preview. Mirrors handleApplyImport's
  // landing — selectedFormat + teams hydrated, no schedule pre-loaded
  // (the previous schedule is stale; the user regenerates against current
  // avoidance constraints), lands on Step 1.
  function handleApplyLinkImport() {
    if (!linkPreview) return;

    // Sort teams + userIds together (numeric collation) so index 0 is the
    // alphabetically-first team — same invariant fresh imports establish.
    // Build an old → new index map so manual doubles and index-format
    // history entries from older payloads come back correctly aligned.
    const pairsWithIdx = linkPreview.teams.map((name, oldIdx) => ({
      name,
      userId: linkPreview.userIds[oldIdx] ?? null,
      oldIdx,
    }));
    pairsWithIdx.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    const nextTeams = pairsWithIdx.map((p) => p.name);
    const nextUserIds = pairsWithIdx.map((p) => p.userId);
    const oldToNew = new Array<number>(linkPreview.teams.length);
    pairsWithIdx.forEach((p, newIdx) => {
      oldToNew[p.oldIdx] = newIdx;
    });
    const remapKey = (key: string): string => {
      if (key.indexOf(":") >= 0) return key;
      const [a, b] = unpackPairKey(key);
      return pairKey(oldToNew[a]!, oldToNew[b]!);
    };

    const remappedHistory: SeasonHistory[] = (linkPreview.history ?? []).map(
      (entry) => ({
        ...entry,
        doubles: (entry.doubles ?? []).map((k) =>
          entry.format === "userid" ? k : remapKey(k),
        ),
      }),
    );
    // manualDoubles intentionally dropped on restore: they're one-time
    // overrides for the season they were set in, and silently carrying
    // them forward would over-constrain the next generation.
    const remappedRivalryPins: RivalryPin[] = (
      linkPreview.rivalryPins ?? []
    ).map((p) => ({
      teamA: oldToNew[p.teamA]!,
      teamB: oldToNew[p.teamB]!,
      week: p.week,
    }));

    const restoredPlatform: ImportPlatform =
      linkPreview.platform === "sleeper" ||
      linkPreview.platform === "espn" ||
      linkPreview.platform === "yahoo" ||
      linkPreview.platform === "manual"
        ? linkPreview.platform
        : "manual";
    const restoredLeagueName = (linkPreview.leagueName || "").trim();
    const nextFormat: SelectedFormat = {
      teamCount: linkPreview.format.teamCount,
      weekCount: linkPreview.format.weekCount,
    };

    patch({
      selectedFormat: nextFormat,
      teams: nextTeams,
      userIds: nextUserIds,
      leagueName: restoredLeagueName,
      history: remappedHistory,
      manualDoubles: new Set(),
      rivalryPins: remappedRivalryPins,
      pinTeamA: 0,
      pinTeamB: 1,
      pinWeek: null,
      schedule: null,
      displayWeeks: null,
      saved: false,
      lookbackOverride: null,
      platform: restoredPlatform,
      importSource: restoredPlatform,
      linkPreview: null,
      shareLinkInput: "",
      shareStatus: "idle",
      shareUrl: "",
      shareError: "",
      shareCopied: false,
      importPreview: null,
      importStatus: "",
      importMsg: "",
      leagueId: "",
      sleeperLeagues: null,
      selectedSleeperLeague: "",
      yahooLeagues: null,
      selectedYahooLeague: "",
      step: "teams",
      furthestStep: "teams",
    });

    saveToStorage({
      format: nextFormat,
      teams: nextTeams,
      userIds: nextUserIds,
      leagueName: restoredLeagueName,
      history: remappedHistory,
      manualDoubles: [],
      lookbackOverride: null,
    });
  }

  function handleManualStart() {
    const tc = manualTeamCount;
    const wc = manualWeekCount;
    const name = manualLeagueName.trim();
    const initialTeams = Array.from({ length: tc }, (_, i) => `Team ${i + 1}`);
    const initialUserIds = Array.from({ length: tc }, () => null) as (
      | string
      | null
    )[];
    // Mirror the handleApplyImport sort path so index 0 is always the
    // alphabetically-first team. No-op for the numbered defaults, but
    // keeps the code path consistent if the default naming changes.
    const sortedPairs = initialTeams
      .map((name, i) => ({ name, userId: initialUserIds[i] ?? null }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    const nextTeams = sortedPairs.map((p) => p.name);
    const nextUserIds = sortedPairs.map((p) => p.userId);
    patch({
      selectedFormat: { teamCount: tc, weekCount: wc },
      teams: nextTeams,
      userIds: nextUserIds,
      leagueName: name,
      history: [],
      manualDoubles: new Set(),
      rivalryPins: [],
      pinTeamA: 0,
      pinTeamB: 1,
      pinWeek: null,
      schedule: null,
      displayWeeks: null,
      saved: false,
      lookbackOverride: null,
      linkPreview: null,
      step: "teams",
      furthestStep: "teams",
      importPreview: null,
      shareLinkInput: "",
      importStatus: "",
      importMsg: "",
      sleeperLeagues: null,
      selectedSleeperLeague: "",
    });
    resetImportUi();
    saveToStorage({
      format: { teamCount: tc, weekCount: wc },
      teams: nextTeams,
      userIds: nextUserIds,
      leagueName: name,
      history: [],
      manualDoubles: [],
      lookbackOverride: null,
    });
  }

  return (
    <>
      {!importPreview && !linkPreview && (
        <div className={cls.subSection}>
          <p className={cls.hint}>
            {importSource === "link" ? (
              <>Paste a share link to restore a previously saved league.</>
            ) : platform === "sleeper" ? (
              <>
                Enter your Sleeper username, or paste your league ID from{" "}
                <code className="font-mono">
                  sleeper.com/leagues/<strong>YOUR_ID</strong>
                </code>
                .
              </>
            ) : platform === "espn" ? (
              <>
                Enter your league ID from{" "}
                <code className="font-mono">
                  fantasy.espn.com/football/league?leagueId=
                  <strong>YOUR_ID</strong>
                </code>{" "}
                (public leagues only - for private leagues, use Manual entry).
              </>
            ) : platform === "manual" ? (
              <>
                For leagues on platforms without automatic import. Enter your
                league info, then add past seasons manually in the next step.
              </>
            ) : (
              <>Connect to Yahoo Fantasy to import your leagues.</>
            )}
          </p>
          <div className="flex flex-wrap gap-2 items-stretch justify-center">
            <select
              className="w-full sm:w-auto bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 outline-none focus:border-slate-500"
              value={importSource}
              onChange={(e) => {
                const next = e.target.value as ImportSource;
                if (next === importSource) return;
                patch({
                  importSource: next,
                  leagueId: "",
                  shareLinkInput: "",
                  linkPreview: null,
                  manualLeagueName: "",
                  manualTeamCount: 12,
                  manualWeekCount: 14,
                  importPreview: null,
                  importStatus: "",
                  importMsg: "",
                  yahooLeagues: null,
                  selectedYahooLeague: "",
                  sleeperLeagues: null,
                  selectedSleeperLeague: "",
                  // platform tracks the most recent real platform (drives apply
                  // instructions, share payload). "link" is a dropdown-only state
                  // so we leave platform alone for that case.
                  ...(next !== "link" ? { platform: next } : {}),
                });
                if (next === "yahoo") {
                  void fetchYahooLeagues();
                }
              }}
            >
              <option value="sleeper">Sleeper</option>
              <option value="espn">ESPN</option>
              <option value="yahoo">Yahoo Fantasy</option>
              <option value="manual">Manual (NFL.com, CBS, other)</option>
              <option value="link">Restore from link</option>
            </select>
            {importSource === "link" ? (
              <>
                <input
                  className={`${cls.leagueInput} font-mono`}
                  value={shareLinkInput}
                  onChange={(e) => {
                    patch({
                      shareLinkInput: e.target.value,
                      ...(linkPreview ? { linkPreview: null } : {}),
                      ...(importStatus
                        ? { importStatus: "", importMsg: "" }
                        : {}),
                    });
                  }}
                  placeholder="https://doublecheckff.com/s/abc12345"
                />
                <button
                  className={cls.primaryBtn}
                  onClick={handleFetchLink}
                  disabled={!shareLinkInput.trim() || importBusy}
                >
                  {importStatus === "loading" ? "Fetching…" : "Fetch"}
                </button>
              </>
            ) : platform === "yahoo" ? (
              yahooLeagues && yahooLeagues.length > 1 ? (
                <>
                  <select
                    className={cls.leagueInput}
                    value={selectedYahooLeague}
                    onChange={(e) =>
                      patch({ selectedYahooLeague: e.target.value })
                    }
                  >
                    <option value="">- pick a league -</option>
                    {yahooLeagues.map((l) => (
                      <option key={l.leagueKey} value={l.leagueKey}>
                        {l.season ? `${l.season} - ` : ""}
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className={cls.primaryBtn}
                    onClick={() => fetchYahooLeagueSeasons(selectedYahooLeague)}
                    disabled={!selectedYahooLeague || importBusy}
                  >
                    {importStatus === "loading"
                      ? "Loading…"
                      : "Use this league"}
                  </button>
                </>
              ) : (
                <button
                  className={cls.primaryBtn}
                  onClick={() => {
                    window.location.href = "/api/auth/yahoo/start";
                  }}
                  disabled={importBusy}
                >
                  {importStatus === "loading"
                    ? "Loading…"
                    : "Connect to Yahoo Fantasy"}
                </button>
              )
            ) : platform === "manual" ? (
              <>
                <input
                  className={cls.leagueInput}
                  value={manualLeagueName}
                  onChange={(e) => patch({ manualLeagueName: e.target.value })}
                  placeholder="League name"
                  maxLength={48}
                />
                <div className="basis-full h-0" aria-hidden="true" />
                <div className="flex gap-2 items-stretch w-full justify-center">
                  <select
                    className="flex-1 sm:flex-none min-w-0 bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 outline-none focus:border-slate-500"
                    value={manualTeamCount}
                    onChange={(e) =>
                      patch({ manualTeamCount: Number(e.target.value) })
                    }
                  >
                    <option value={8}>8 teams</option>
                    <option value={10}>10 teams</option>
                    <option value={12}>12 teams</option>
                    <option value={14}>14 teams</option>
                  </select>
                  <select
                    className="flex-1 sm:flex-none min-w-0 bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 outline-none focus:border-slate-500"
                    value={manualWeekCount}
                    onChange={(e) =>
                      patch({ manualWeekCount: Number(e.target.value) })
                    }
                  >
                    <option value={13}>13 weeks</option>
                    <option value={14}>14 weeks</option>
                    <option value={15}>15 weeks</option>
                  </select>
                  <button
                    className={cls.primaryBtn}
                    onClick={handleManualStart}
                    disabled={!manualLeagueName.trim()}
                  >
                    Start
                  </button>
                </div>
              </>
            ) : platform === "sleeper" &&
              sleeperLeagues &&
              sleeperLeagues.length > 1 ? (
              <>
                <select
                  className={cls.leagueInput}
                  value={selectedSleeperLeague}
                  onChange={(e) =>
                    patch({ selectedSleeperLeague: e.target.value })
                  }
                >
                  <option value="">- pick a league -</option>
                  {sleeperLeagues.map((l) => (
                    <option key={l.leagueId} value={l.leagueId}>
                      {l.season ? `${l.season} - ` : ""}
                      {l.name}
                    </option>
                  ))}
                </select>
                <button
                  className={cls.primaryBtn}
                  onClick={() =>
                    fetchSleeperLeagueSeasons(selectedSleeperLeague)
                  }
                  disabled={!selectedSleeperLeague || importBusy}
                >
                  {importStatus === "loading" ? "Loading…" : "Use this league"}
                </button>
              </>
            ) : (
              <>
                <input
                  className={`${cls.leagueInput} font-mono`}
                  value={leagueId}
                  onChange={(e) => {
                    patch({
                      leagueId: e.target.value,
                      ...(importPreview ? { importPreview: null } : {}),
                      ...(sleeperLeagues
                        ? { sleeperLeagues: null, selectedSleeperLeague: "" }
                        : {}),
                      ...(importStatus
                        ? { importStatus: "", importMsg: "" }
                        : {}),
                    });
                  }}
                  placeholder={
                    platform === "sleeper"
                      ? "e.g. karimcozey or 1180738142470492160"
                      : "e.g. 123456789"
                  }
                />
                <button
                  className={cls.primaryBtn}
                  onClick={handleFetch}
                  disabled={!leagueId.trim() || importBusy}
                >
                  {importStatus === "loading" ? "Fetching…" : "Fetch"}
                </button>
              </>
            )}
          </div>

          {importStatus === "error" && importHelpUrl ? (
            <p className={`text-[11px] mt-2 ${statusToneClass(importStatus)}`}>
              This ESPN league is private. Temporarily make your league public (
              <a
                href={importHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-slate-300 underline hover:text-slate-200"
              >
                see instructions
              </a>
              ), then try again. Or, choose Manual entry to import without
              changing any ESPN settings.
            </p>
          ) : (
            importMsg &&
            !importPreview &&
            !linkPreview && (
              <p
                className={`text-[11px] mt-2 text-center ${statusToneClass(importStatus)}`}
              >
                {importMsg}
              </p>
            )
          )}
        </div>
      )}

      {/* Shared import preview */}
      {importPreview &&
        (() => {
          const mostRecent = importPreview.seasons[0]!;
          const detected = detectFormatFromImport(mostRecent);
          if (!detected) return null;
          const leagueLabel = (mostRecent.seasonName || "").trim();
          const platformName = platformLabel(importPreview.platform);
          const formatLabel = `${detected.teamCount}-team / ${detected.weekCount}-week`;
          const seasonCount = importPreview.seasons.length;
          const years = importPreview.seasons
            .map((s) => s.seasonYear || "?")
            .join(", ");
          const sortedManagers = [...mostRecent.teamNames].sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
          );
          return (
            <div className="mb-3 px-3 py-2.5 bg-slate-800 rounded-md border border-emerald-700">
              <p className="text-xs text-slate-200 mb-1">
                {leagueLabel ? (
                  <>
                    <strong className="text-emerald-400">{leagueLabel}</strong>
                    <span className="text-slate-500"> · </span>
                    {formatLabel}
                    <span className="text-slate-500"> · </span>
                    {platformName}
                  </>
                ) : (
                  <>
                    <strong className="text-emerald-400">{platformName}</strong>
                    <span className="text-slate-500"> · </span>
                    {formatLabel}
                  </>
                )}
              </p>
              <p className="text-[11px] text-slate-400 mb-2">
                {seasonCount} season{seasonCount > 1 ? "s" : ""}: {years}
              </p>
              <p className="text-[11px] text-slate-500 mb-2">
                Managers: {sortedManagers.join(", ")}
              </p>
              <div className="flex gap-2 flex-wrap items-center justify-center">
                <button
                  className={cls.secondaryBtn}
                  onClick={() => patch({ importPreview: null })}
                >
                  Cancel
                </button>
                <button className={cls.primaryBtn} onClick={handleApplyImport}>
                  Apply
                </button>
              </div>
            </div>
          );
        })()}

      {/* Shared-link import preview */}
      {linkPreview &&
        (() => {
          const leagueLabel = (linkPreview.leagueName || "").trim();
          const restoredPlatform: ImportPlatform =
            linkPreview.platform === "sleeper" ||
            linkPreview.platform === "espn" ||
            linkPreview.platform === "yahoo" ||
            linkPreview.platform === "manual"
              ? linkPreview.platform
              : "manual";
          const platformName = platformLabel(restoredPlatform);
          const formatLabel = `${linkPreview.format.teamCount}-team / ${linkPreview.format.weekCount}-week`;
          const historyEntries = linkPreview.history ?? [];
          const seasonCount = historyEntries.length;
          const years = historyEntries.map((h) => h.season || "?").join(", ");
          const sortedManagers = [...linkPreview.teams].sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
          );
          return (
            <div className="mb-3 px-3 py-2.5 bg-slate-800 rounded-md border border-emerald-700">
              <p className="text-xs text-slate-200 mb-1">
                {leagueLabel ? (
                  <>
                    <strong className="text-emerald-400">{leagueLabel}</strong>
                    <span className="text-slate-500"> · </span>
                    {formatLabel}
                    <span className="text-slate-500"> · </span>
                    {platformName}
                  </>
                ) : (
                  <>
                    <strong className="text-emerald-400">{platformName}</strong>
                    <span className="text-slate-500"> · </span>
                    {formatLabel}
                  </>
                )}
              </p>
              {seasonCount > 0 && (
                <p className="text-[11px] text-slate-400 mb-2">
                  {seasonCount} season{seasonCount > 1 ? "s" : ""}: {years}
                </p>
              )}
              <p className="text-[11px] text-slate-500 mb-2">
                Managers: {sortedManagers.join(", ")}
              </p>
              <div className="flex gap-2 flex-wrap items-center justify-center">
                <button
                  className={cls.secondaryBtn}
                  onClick={() => patch({ linkPreview: null })}
                >
                  Cancel
                </button>
                <button
                  className={cls.primaryBtn}
                  onClick={handleApplyLinkImport}
                >
                  Apply
                </button>
              </div>
            </div>
          );
        })()}
    </>
  );
}

type StepImportProps = {
  state: State;
  patch: Patch;
  saveToStorage: SaveToStorageFn;
  stepOrder: ReadonlyArray<"teams" | "doubles" | "schedule">;
};

export function StepImport(props: StepImportProps) {
  const { state, patch, saveToStorage, stepOrder } = props;
  const { teams, leagueName, furthestStep } = state;

  return (
    <div className={cls.card}>
      <h2 className={cls.cardTitle}>{leagueName || "Managers"}</h2>

      <p className={cls.hint}>Edit names as needed.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {teams.map((t, i) => (
          <div
            key={i}
            className="flex items-center gap-2 bg-slate-900 rounded-md px-2 py-1 border border-slate-700"
          >
            <span className="text-[11px] text-slate-600 min-w-[1rem] text-right">
              {i + 1}
            </span>
            <input
              className={cls.teamInput}
              value={t}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const next = [...teams];
                next[i] = e.target.value;
                patch({ teams: next });
              }}
              placeholder={`Team ${i + 1}`}
              maxLength={24}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-3 mt-6 flex-wrap justify-center">
        <button
          className={cls.primaryBtn}
          onClick={() => {
            saveToStorage();
            const nextFurthest =
              stepOrder.indexOf(furthestStep) < stepOrder.indexOf("doubles")
                ? "doubles"
                : furthestStep;
            patch({ step: "doubles", furthestStep: nextFurthest });
          }}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
