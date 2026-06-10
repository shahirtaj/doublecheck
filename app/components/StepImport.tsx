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
  FailedImportSeason,
  ImportPlatform,
  ImportSource,
  ImportedSeasonRecord,
  SelectedFormat,
  SleeperLeagueOption,
  YahooLeagueOption,
} from "./types";
import {
  buildImportedHistoryRows,
  describeWithholdingGap,
  importSeasonsParam,
  detectFormatFromImport,
  extractSlug,
  formatDetectionErrorMessage,
  mergeImportedHistory,
  normalizeHistory,
  platformLabel,
  remapIndexRowsByName,
  sharesRoster,
  withholdingErrorMessage,
  withholdingWarningMessage,
  withholdPreGapSeasons,
} from "./utils";
import type { Patch, SaveToStorageFn, State } from "./state";

type ImportSectionsProps = {
  state: State;
  patch: Patch;
  saveToStorage: SaveToStorageFn;
  platformRef: MutableRefObject<ImportPlatform>;
  importSourceRef: MutableRefObject<ImportSource>;
  importSeqRef: MutableRefObject<number>;
};

// Manual import dropdown options. A week count outside the selected team
// count's round-robin range (8 teams caps at 2*(8-1) = 14) renders disabled
// with a "needs N+ teams" hint rather than hidden: such seasons exist on
// real platforms (someone just plays a third matchup), they're outside
// DoubleCheck's once-or-twice scope - so the UI should teach the limit, not
// imply the league shape doesn't exist. Switching team counts still clamps
// an out-of-range selection (a select can't keep a disabled value).
const MANUAL_TEAM_OPTIONS = [8, 10, 12, 14];
const MANUAL_WEEK_OPTIONS = [13, 14, 15];

// Sentinel for "this response went stale mid-flight and must be discarded" -
// distinct from every JSON value a route can return (including null).
const STALE = Symbol("stale-import-response");

// Filter imported seasons down to the format detected from the most recent
// season. Older seasons with a different roster size are dropped because
// their team-index space wouldn't line up with the detected format. The
// dropped seasons are returned too: a roster-filtered year leaves the same
// hole in the surviving run as a failed fetch, so it must feed the same
// gap-withholding decision. Detection anchors on seasons[0] (the newest -
// responses are most-recent-first), so the newest season always survives.
function filterToDetectedFormat(seasons: ImportedSeasonRecord[]): {
  detected: SelectedFormat;
  seasons: ImportedSeasonRecord[];
  dropped: ImportedSeasonRecord[];
} | null {
  const detected = detectFormatFromImport(seasons[0]!);
  if (!detected) return null;
  const kept: ImportedSeasonRecord[] = [];
  const dropped: ImportedSeasonRecord[] = [];
  for (const s of seasons) {
    (s.teamNames?.length === detected.teamCount ? kept : dropped).push(s);
  }
  return { detected, seasons: kept, dropped };
}

// Split an import-route response into seasons + failed attempts. Full success
// is a bare ImportedSeasonRecord[] (Array.isArray is the discriminator);
// partial success — some seasons failed both server-side fetch attempts — is
// { seasons, failed }. Yahoo only ever returns the bare array: its sequential
// chain walk truncates at a failure instead of reporting gaps.
function splitImportResponse(data: unknown): {
  seasons: ImportedSeasonRecord[];
  failed: FailedImportSeason[];
} {
  if (Array.isArray(data)) {
    return { seasons: data as ImportedSeasonRecord[], failed: [] };
  }
  if (data && typeof data === "object") {
    const partial = data as {
      seasons?: ImportedSeasonRecord[];
      failed?: FailedImportSeason[];
    };
    if (Array.isArray(partial.seasons)) {
      return {
        seasons: partial.seasons,
        failed: Array.isArray(partial.failed) ? partial.failed : [],
      };
    }
  }
  return { seasons: [], failed: [] };
}

export function ImportSections(props: ImportSectionsProps) {
  const {
    state,
    patch,
    saveToStorage,
    platformRef,
    importSourceRef,
    importSeqRef,
  } = props;
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
    priorFormat,
    teams,
    userIds,
    history,
    pendingYahooConnect,
  } = state;

  const importBusy = importStatus === "loading";

  // selectedFormat is null whenever this component is mounted (the import UI
  // only renders without a format) — Back stashes the cleared format in
  // priorFormat so re-imports can still compare against the league whose
  // teams/history are loaded. Null only on a truly fresh start.
  const baselineFormat = selectedFormat ?? priorFormat;

  // ?seasons=N for the platform fetches below: right-sized to the known
  // format on a re-import, the works-for-any-format maximum on a fresh one
  // (see importSeasonsParam).
  const requestSeasons = importSeasonsParam(baselineFormat);

  // Shared landing for every platform season fetch. Splits the response
  // shape, filters to the detected format, and withholds imported seasons
  // older than the newest gap before they can reach the preview/merge —
  // buildAvoidMap ages history by array index, so a gapped run mis-ages
  // every older season and the missing season's doubles carry zero
  // avoidance cost. A gap is any attempted year that's missing from the
  // surviving run, whether it failed to fetch or was roster-filtered by
  // filterToDetectedFormat — both feed the same withholding decision. A
  // gap year already covered by an existing history row isn't a gap (the
  // merge fills the hole), but a format change drops existing history at
  // merge time (handleApplyImport), so existing rows can't fill gaps in
  // that case. Throws (for the caller's catch → importStatus error) when
  // nothing importable survives.
  // `requestedSeasons` is the size the request was sent with. When detection
  // reveals the league wants more than that - the request was sized to
  // baselineFormat, but the league (or which league) changed shape to a
  // bigger-lookback format - AND the request was the binding constraint
  // (attempted = returned + failed filled it; a league with less real
  // history than requested has nothing more to give), the function returns
  // the right size to refetch with INSTEAD of patching the preview. Pass
  // null to disable the check (the refetch itself); returns null after
  // patching.
  function previewFetchedSeasons(
    plat: ImportPlatform,
    data: unknown,
    requestedSeasons: number | null,
  ): number | null {
    const { seasons, failed } = splitImportResponse(data);
    if (seasons.length === 0) {
      throw new Error("No seasons returned.");
    }
    const detected = filterToDetectedFormat(seasons);
    if (!detected) {
      throw new Error(formatDetectionErrorMessage(seasons[0]!));
    }
    if (requestedSeasons !== null) {
      const needed = importSeasonsParam(detected.detected);
      if (
        needed > requestedSeasons &&
        seasons.length + failed.length >= requestedSeasons
      ) {
        return needed;
      }
    }
    const formatChanged =
      !baselineFormat ||
      baselineFormat.teamCount !== detected.detected.teamCount ||
      baselineFormat.weekCount !== detected.detected.weekCount;
    // A same-shape import of a different league drops history too (see
    // sharesRoster) - the withholding decision must agree with what Apply
    // will do, so the old league's rows never fill the new league's gaps.
    const leagueChanged =
      formatChanged || !sharesRoster(teams, userIds, detected.seasons[0]!);
    // Roster-filtered years are gaps too: a 12 -> 10 -> 12 league loses the
    // 10-team middle year(s) to the format filter, and the surviving run has
    // the same hole a failed fetch would leave. The messaging distinguishes
    // the causes because the remedies differ — retry can recover a failed
    // fetch, never a different-sized season.
    const rosterGapCandidates: FailedImportSeason[] = detected.dropped.map(
      (s) => ({
        season: (s.seasonYear ?? "").trim(),
        error: "different roster size",
      }),
    );
    const { kept, withheldYears, gapYears } = withholdPreGapSeasons(
      detected.seasons,
      [...failed, ...rosterGapCandidates],
      leagueChanged ? [] : history,
    );

    const { cause, remedy } = describeWithholdingGap(
      gapYears,
      failed,
      detected.dropped,
      detected.detected,
    );

    if (kept.length === 0) {
      throw new Error(withholdingErrorMessage(cause, remedy));
    }
    patch({
      importPreview: { platform: plat, seasons: kept },
      importStatus: "ready",
      importMsg:
        withheldYears.length > 0
          ? withholdingWarningMessage(cause, remedy, withheldYears)
          : "",
    });
    return null;
  }

  // One POST round trip to an import route. Returns the parsed body, or
  // STALE when the response should be discarded (the caller returns
  // immediately). Non-OK responses throw the route's error message for the
  // caller's catch; captureHelpUrl forwards an error body's helpUrl into
  // state first (the ESPN private-league instructions link).
  async function postSeasonsRequest(
    plat: ImportPlatform,
    seasons: number,
    body: Record<string, unknown>,
    stale: () => boolean,
    captureHelpUrl: boolean,
  ): Promise<unknown> {
    const res = await fetch(`/api/import/${plat}?seasons=${seasons}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (stale()) return STALE;
    const data = await res.json();
    if (stale()) return STALE;
    if (!res.ok) {
      if (captureHelpUrl && typeof data?.helpUrl === "string") {
        patch({ importHelpUrl: data.helpUrl });
      }
      throw new Error(data?.error || `Request failed (HTTP ${res.status}).`);
    }
    return data;
  }

  // Fetch a platform's seasons and land them in the preview. When detection
  // reveals a bigger lookback appetite than the request was sized for (see
  // previewFetchedSeasons), refetch once at the detected size; if that
  // second fetch fails, fall back to previewing the first response - it was
  // valid, just possibly short, which is exactly the pre-refetch behavior.
  async function fetchSeasonsIntoPreview(
    plat: ImportPlatform,
    body: Record<string, unknown>,
    stale: () => boolean,
    captureHelpUrl = false,
  ): Promise<void> {
    const data = await postSeasonsRequest(
      plat,
      requestSeasons,
      body,
      stale,
      captureHelpUrl,
    );
    if (data === STALE) return;
    const refetchSize = previewFetchedSeasons(plat, data, requestSeasons);
    if (refetchSize === null) return;
    let second: unknown = null;
    try {
      second = await postSeasonsRequest(
        plat,
        refetchSize,
        body,
        stale,
        captureHelpUrl,
      );
    } catch {
      second = null;
    }
    if (second === STALE) return;
    previewFetchedSeasons(plat, second ?? data, null);
  }

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
    // Stale-response guard: if the user switches the platform dropdown (or
    // flips to "Restore from link", which leaves `platform` alone by design)
    // while this request is in flight, the response must not stomp the new
    // selection's shared status fields. Checked after every await.
    const requestPlatform = platform;
    const requestSource = importSource;
    // The seq claim also covers what value checks can't: a newer fetch on
    // the SAME platform/source (typo'd ID refetched) or an A-B-A dropdown
    // round trip that lands the refs back on their original values.
    const requestSeq = ++importSeqRef.current;
    const stale = () =>
      platformRef.current !== requestPlatform ||
      importSourceRef.current !== requestSource ||
      importSeqRef.current !== requestSeq;
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
        importMsg: `Fetching Sleeper leagues for "${input}"…`,
      });
      try {
        const res = await fetch("/api/import/sleeper", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: input }),
        });
        if (stale()) return;
        const data = await res.json();
        if (stale()) return;
        if (!res.ok)
          throw new Error(
            data?.error || `Request failed (HTTP ${res.status}).`,
          );
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
        if (stale()) return;
        patch({
          importStatus: "error",
          importMsg: (e as Error).message || "Could not look up Sleeper user.",
        });
      }
      return;
    }

    patch({
      importStatus: "loading",
      importMsg: `Fetching season data from ${platformLabel(platform)}…`,
    });
    try {
      await fetchSeasonsIntoPreview(platform, { leagueId: input }, stale, true);
    } catch (e) {
      if (stale()) return;
      patch({
        importStatus: "error",
        importMsg:
          (e as Error).message ||
          `Could not fetch season data from ${platformLabel(platform)}.`,
      });
    }
  }

  async function fetchSleeperLeagueSeasons(specificLeagueId: string) {
    const requestSeq = ++importSeqRef.current;
    const stale = () =>
      platformRef.current !== "sleeper" ||
      importSourceRef.current !== "sleeper" ||
      importSeqRef.current !== requestSeq;
    patch({
      importStatus: "loading",
      importMsg: "Fetching season data from Sleeper…",
      importPreview: null,
    });
    try {
      await fetchSeasonsIntoPreview(
        "sleeper",
        { leagueId: specificLeagueId },
        stale,
      );
    } catch (e) {
      if (stale()) return;
      patch({
        importStatus: "error",
        importMsg:
          (e as Error).message || "Could not fetch season data from Sleeper.",
      });
    }
  }

  // Yahoo helpers ─ separate from handleFetch because the flow is two-step:
  // first list the user's leagues (no body), then fetch a chosen league's
  // season chain (with leagueKey). 401 means the user hasn't gone through
  // OAuth yet (or their refresh token expired); the UI shows Connect Yahoo.

  async function fetchYahooLeagueSeasons(leagueKey: string) {
    const requestSeq = ++importSeqRef.current;
    const stale = () =>
      platformRef.current !== "yahoo" ||
      importSourceRef.current !== "yahoo" ||
      importSeqRef.current !== requestSeq;
    patch({
      importStatus: "loading",
      importMsg: "Fetching season data from Yahoo Fantasy…",
      importPreview: null,
    });
    try {
      await fetchSeasonsIntoPreview("yahoo", { leagueKey }, stale);
    } catch (e) {
      if (stale()) return;
      patch({
        importStatus: "error",
        importMsg:
          (e as Error).message ||
          "Could not fetch season data from Yahoo Fantasy.",
      });
    }
  }

  async function fetchYahooLeagues() {
    const requestSeq = ++importSeqRef.current;
    const stale = () =>
      platformRef.current !== "yahoo" ||
      importSourceRef.current !== "yahoo" ||
      importSeqRef.current !== requestSeq;
    patch({
      importStatus: "loading",
      importMsg: "Fetching Yahoo Fantasy leagues…",
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
      if (stale()) return;
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
      if (stale()) return;
      if (!res.ok)
        throw new Error(data?.error || `Request failed (HTTP ${res.status}).`);
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
      if (stale()) return;
      patch({
        importStatus: "error",
        importMsg:
          (e as Error).message || "Could not fetch Yahoo Fantasy leagues.",
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
    // data wins over any local edits. A format change - or a same-shape
    // import of a different league (see sharesRoster) - additionally resets
    // the lookback override and drops the prior history (handled below)
    // since its rows belong to a different roster.
    const formatChanged =
      !baselineFormat ||
      baselineFormat.teamCount !== detected.teamCount ||
      baselineFormat.weekCount !== detected.weekCount;
    const leagueChanged =
      formatChanged || !sharesRoster(teams, userIds, mostRecent);

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
    const importedRows: SeasonHistory[] = buildImportedHistoryRows(
      seasonsOldestFirst,
      nextTeams,
    );
    // Upsert by year + chronological re-sort. A Save & Share row for the
    // in-progress season may be replaced here: Yahoo (isFinished gate) and
    // ESPN (default start = currentYear - 1) only return completed seasons,
    // but Sleeper includes the current year once week 1 has points. That's
    // fine - the upsert keeps one row, and priorSeasons keeps the current
    // year out of avoidance. Surviving index rows are re-keyed onto the
    // re-sorted roster first - the merge replaces same-year rows wholesale,
    // but rows the import doesn't cover would otherwise keep positions from
    // the old sort order.
    const newHistory = mergeImportedHistory(
      leagueChanged ? [] : remapIndexRowsByName(history, teams, nextTeams),
      importedRows,
    );

    // Adopt the most recent season's league name. The Yahoo picker, ESPN's
    // settings.name, and Sleeper's league.name all flow through seasonName.
    const nextLeagueName = (mostRecent.seasonName || "").trim();

    patch({
      // Always restore selectedFormat: Back cleared it to re-enter the import
      // UI, so even a same-shape re-import must set it to land on the steps.
      selectedFormat: detected,
      priorFormat: null,
      ...(leagueChanged ? { lookbackOverride: null } : {}),
      teams: nextTeams,
      userIds: nextUserIds,
      history: newHistory,
      ...(nextLeagueName ? { leagueName: nextLeagueName } : {}),
      manualDoubles: new Set(),
      rivalryPins: [],
      // The pin list was just replaced, so an armed per-row Remove confirm
      // would re-arm on whatever pin lands at that index next.
      confirmRemovePinIndex: null,
      pinTeamA: 0,
      pinTeamB: 1,
      pinWeek: null,
    });

    saveToStorage({
      history: newHistory,
      teams: nextTeams,
      userIds: nextUserIds,
      format: detected,
      // The patch above hasn't flushed, so the cleared pins must ride along
      // or the save would persist the closure's stale pin list.
      rivalryPins: [],
      ...(nextLeagueName ? { leagueName: nextLeagueName } : {}),
      ...(leagueChanged ? { lookbackOverride: null } : {}),
    });
  }

  async function handleFetchLink() {
    // Switching the dropdown off "Restore from link" leaves `platform`
    // unchanged, so the source ref is the only signal that this response
    // is stale.
    const requestSeq = ++importSeqRef.current;
    const stale = () =>
      importSourceRef.current !== "link" || importSeqRef.current !== requestSeq;
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
      if (stale()) return;
      const raw = await res.json();
      if (stale()) return;
      if (!res.ok)
        throw new Error(raw?.error || `Request failed (HTTP ${res.status}).`);
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
      // Range-checked, not just type-checked: links predating the server
      // validator's format bounds could carry an unschedulable shape (e.g.
      // 8 teams / 15 weeks), which would misrender or fail generation.
      if (
        typeof payload.format.teamCount !== "number" ||
        typeof payload.format.weekCount !== "number" ||
        payload.format.teamCount < 2 ||
        payload.format.teamCount % 2 !== 0 ||
        payload.format.weekCount < payload.format.teamCount - 1 ||
        payload.format.weekCount > 2 * (payload.format.teamCount - 1)
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
      if (stale()) return;
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

    // normalizeHistory self-heals share payloads written before the import
    // merge deduped by year: duplicate-year rows collapse (last one wins)
    // and the rows come back in chronological order.
    const remappedHistory: SeasonHistory[] = normalizeHistory(
      (linkPreview.history ?? []).map((entry) => ({
        ...entry,
        doubles: (entry.doubles ?? []).map((k) =>
          entry.format === "userid" ? k : remapKey(k),
        ),
      })),
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
      priorFormat: null,
      teams: nextTeams,
      userIds: nextUserIds,
      leagueName: restoredLeagueName,
      history: remappedHistory,
      manualDoubles: new Set(),
      rivalryPins: remappedRivalryPins,
      // Replaced pin list - drop any armed per-row Remove confirm.
      confirmRemovePinIndex: null,
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
      rivalryPins: remappedRivalryPins,
      lookbackOverride: null,
      platform: restoredPlatform,
    });
  }

  function handleManualStart() {
    const tc = manualTeamCount;
    const wc = manualWeekCount;
    // The dropdowns keep the pair inside the round-robin range, but guard
    // anyway - an out-of-range pair (e.g. 8 teams / 15 weeks) would land on
    // a factually wrong edge-case card instead of a schedulable format.
    if (wc < tc - 1 || wc > 2 * (tc - 1)) return;
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
      priorFormat: null,
      teams: nextTeams,
      userIds: nextUserIds,
      leagueName: name,
      history: [],
      manualDoubles: new Set(),
      rivalryPins: [],
      // Replaced pin list - drop any armed per-row Remove confirm.
      confirmRemovePinIndex: null,
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
      rivalryPins: [],
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
                (public leagues only - for private leagues, use Manual import).
              </>
            ) : platform === "manual" ? (
              <>
                Enter your league info, then add past seasons in the next step.
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
                // Invalidate every in-flight request - the seq check is what
                // catches an A-B-A switch back to the original selection,
                // where the platform/source values match again at response
                // time.
                importSeqRef.current++;
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
                    <option value="">Select a league</option>
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
                      ? "Fetching…"
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
                    ? "Fetching…"
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
                    onChange={(e) => {
                      const tc = Number(e.target.value);
                      // Clamp the week count into the new team count's valid
                      // round-robin range so the pair can never go out of
                      // bounds (8 teams caps at 2*(8-1) = 14 weeks).
                      const maxWeeks = 2 * (tc - 1);
                      patch({
                        manualTeamCount: tc,
                        ...(manualWeekCount > maxWeeks
                          ? { manualWeekCount: maxWeeks }
                          : {}),
                      });
                    }}
                  >
                    {MANUAL_TEAM_OPTIONS.map((tc) => (
                      <option key={tc} value={tc}>
                        {tc} teams
                      </option>
                    ))}
                  </select>
                  <select
                    className="flex-1 sm:flex-none min-w-0 bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 outline-none focus:border-slate-500"
                    value={manualWeekCount}
                    onChange={(e) =>
                      patch({ manualWeekCount: Number(e.target.value) })
                    }
                  >
                    {MANUAL_WEEK_OPTIONS.map((w) => {
                      const valid =
                        w >= manualTeamCount - 1 &&
                        w <= 2 * (manualTeamCount - 1);
                      const minTeams = MANUAL_TEAM_OPTIONS.find(
                        (tc) => w >= tc - 1 && w <= 2 * (tc - 1),
                      );
                      return (
                        <option key={w} value={w} disabled={!valid}>
                          {valid || !minTeams
                            ? `${w} weeks`
                            : `${w} weeks (needs ${minTeams}+ teams)`}
                        </option>
                      );
                    })}
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
                  <option value="">Select a league</option>
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
                  {importStatus === "loading" ? "Fetching…" : "Use this league"}
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
              ), then try again. Or, use Manual import without changing any ESPN
              settings.
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
              {importMsg && (
                <p className="text-[11px] text-amber-400 mb-2">{importMsg}</p>
              )}
              <div className="flex gap-2 flex-wrap items-center justify-center">
                <button
                  className={cls.secondaryBtn}
                  onClick={() =>
                    patch({
                      importPreview: null,
                      importStatus: "",
                      importMsg: "",
                    })
                  }
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
