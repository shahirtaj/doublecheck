"use client";

import { useEffect } from "react";
import {
  pairKey,
  unpackPairKey,
  type AvoidMap,
  type FormatProperties,
  type LookbackWindow,
  type PairKey,
  type RivalryPin,
  type SeasonHistory,
} from "@/lib/algorithm";
import { cls } from "./styles";
import { abbrev } from "./utils";
import { CURRENT_YEAR, CURRENT_YEAR_STR } from "./constants";
import type { Patch, SaveToStorageFn, State } from "./state";

type AvoidSets = { hard: Set<PairKey>; soft: Set<PairKey> };

type StepReviewProps = {
  state: State;
  patch: Patch;
  saveToStorage: SaveToStorageFn;
  format: FormatProperties;
  avoidSets: AvoidMap;
  mergedAvoidSets: AvoidSets;
  effectiveLookback: LookbackWindow;
  effectiveLookbackTotal: number;
  recommendedLookbackTotal: number;
  showHeaderTooltip: (text: string, target: HTMLElement) => void;
  hideHeaderTooltip: () => void;
  // handleGenerate logic lives in page.tsx so StepSchedule's Regenerate button
  // can share the same implementation. We accept it as a prop and call it from
  // the Generate Schedule button below.
  onGenerate: () => void;
};

export function StepReview(props: StepReviewProps) {
  const {
    state,
    patch,
    saveToStorage,
    format,
    avoidSets,
    mergedAvoidSets,
    effectiveLookback,
    effectiveLookbackTotal,
    recommendedLookbackTotal,
    showHeaderTooltip,
    hideHeaderTooltip,
    onGenerate,
  } = props;
  const {
    teams,
    userIds,
    leagueName,
    manualDoubles,
    rivalryPins,
    pinTeamA,
    pinTeamB,
    pinWeek,
    pinJustAdded,
    history,
    selectedFormat,
    genError,
    addingPastSeason,
    pastSeasonYear,
    pastSeasonDoubles,
    editingSeasonIndex,
    confirmDeleteSeasonIndex,
    confirmClearManualDoubles,
    confirmClearRivalryPins,
    confirmRemovePinIndex,
    hoveredAvoidCell,
    hoveredPastSeasonCell,
    canHover,
  } = state;

  const teamCount = selectedFormat?.teamCount ?? 0;
  const weekCount = selectedFormat?.weekCount ?? 0;

  // Dismiss the matrix header tooltip on page scroll. The tooltip is
  // fixed-position relative to the header's bounding rect at hover time;
  // when only the page (not the matrix overflow container) scrolls, the
  // per-container onScroll handlers don't fire and the tooltip is left
  // pointing at empty space.
  useEffect(() => {
    const handleScroll = () => {
      hideHeaderTooltip();
      patch({ hoveredAvoidCell: null, hoveredPastSeasonCell: null });
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [hideHeaderTooltip, patch]);

  // Years offered by the "Add Past Season" dropdown, sized to the format's
  // recommended lookback so we don't surface seasons that can't influence
  // schedule generation.
  const pastSeasonYears = Array.from(
    { length: recommendedLookbackTotal },
    (_, i) => CURRENT_YEAR - recommendedLookbackTotal + i,
  );
  const usedSeasonYears = new Set(history.map((h) => h.season));
  const availablePastSeasonYears = pastSeasonYears.filter(
    (y) => !usedSeasonYears.has(String(y)),
  );
  // When the user opens the add form with a history already filling (or
  // exceeding) the recommended lookback window, surface a heads-up that
  // further seasons won't influence schedule generation.
  const showLookbackNote =
    addingPastSeason &&
    editingSeasonIndex === null &&
    history.length >= recommendedLookbackTotal;

  function toggleDouble(i: number, j: number) {
    const key = pairKey(i, j);
    const next = new Set(manualDoubles);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    patch({ manualDoubles: next });
  }

  function togglePastSeasonDouble(i: number, j: number) {
    const key = pairKey(i, j);
    const next = new Set(pastSeasonDoubles);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    patch({ pastSeasonDoubles: next });
  }

  function handleApplyPastSeason() {
    const year = pastSeasonYear.trim();
    if (!year) return;
    let nextHistory: SeasonHistory[];
    if (editingSeasonIndex !== null) {
      const original = history[editingSeasonIndex];
      if (!original) return;
      let doubles: PairKey[] = [...pastSeasonDoubles];
      let entryFormat: "userid" | "index" = "index";
      // Preserve userid format when editing an imported season, but only if
      // every selected pair maps to a known userId. Otherwise fall back to
      // index format so we don't write keys that reference missing users.
      const allHaveUserIds = [...pastSeasonDoubles].every((key) => {
        const [a, b] = unpackPairKey(key);
        return userIds[a] != null && userIds[b] != null;
      });
      if (original.format === "userid" && allHaveUserIds) {
        doubles = [...pastSeasonDoubles].map((key) => {
          const [a, b] = unpackPairKey(key);
          return [userIds[a], userIds[b]].sort().join(":");
        });
        entryFormat = "userid";
      }
      const updated: SeasonHistory = {
        season: year,
        doubles,
        format: entryFormat,
      };
      nextHistory = history.map((h, i) =>
        i === editingSeasonIndex ? updated : h,
      );
    } else {
      const entry: SeasonHistory = {
        season: year,
        doubles: [...pastSeasonDoubles],
        format: "index",
      };
      nextHistory = [...history, entry].sort((a, b) => {
        const aN = Number(a.season);
        const bN = Number(b.season);
        if (Number.isNaN(aN) || Number.isNaN(bN)) return 0;
        return aN - bN;
      });
    }
    patch({
      history: nextHistory,
      pastSeasonYear: CURRENT_YEAR_STR,
      pastSeasonDoubles: new Set(),
      addingPastSeason: false,
      editingSeasonIndex: null,
    });
    saveToStorage({ history: nextHistory });
  }

  function handleCancelPastSeason() {
    patch({
      pastSeasonYear: CURRENT_YEAR_STR,
      pastSeasonDoubles: new Set(),
      addingPastSeason: false,
      editingSeasonIndex: null,
    });
  }

  function handleStartAddSeason() {
    const used = new Set(history.map((h) => h.season));
    const available = pastSeasonYears.filter((y) => !used.has(String(y)));
    if (available.length === 0) return;
    const defaultYear = String(available[available.length - 1]);
    patch({
      pastSeasonYear: defaultYear,
      pastSeasonDoubles: new Set(),
      editingSeasonIndex: null,
      confirmDeleteSeasonIndex: null,
      confirmClearManualDoubles: false,
      confirmClearRivalryPins: false,
      addingPastSeason: true,
    });
  }

  function handleStartEditSeason(index: number) {
    const entry = history[index];
    if (!entry) return;
    // Convert userid-format doubles back to index pair keys against the
    // current roster so the matrix can render and toggle them. Pairs that
    // reference users no longer in the league are silently dropped.
    const indexPairs = new Set<PairKey>();
    for (const key of entry.doubles ?? []) {
      if (entry.format === "userid") {
        const colon = key.indexOf(":");
        if (colon < 0) continue;
        const uid1 = key.slice(0, colon);
        const uid2 = key.slice(colon + 1);
        const i1 = userIds.indexOf(uid1);
        const i2 = userIds.indexOf(uid2);
        if (i1 < 0 || i2 < 0) continue;
        indexPairs.add(pairKey(i1, i2));
      } else {
        indexPairs.add(key);
      }
    }
    patch({
      pastSeasonYear: entry.season,
      pastSeasonDoubles: indexPairs,
      editingSeasonIndex: index,
      confirmDeleteSeasonIndex: null,
      confirmClearManualDoubles: false,
      confirmClearRivalryPins: false,
      addingPastSeason: true,
    });
  }

  function handleDeleteSeason(index: number) {
    const nextHistory = history.filter((_, i) => i !== index);
    patch({ history: nextHistory, confirmDeleteSeasonIndex: null });
    saveToStorage({ history: nextHistory });
  }

  function pastSeasonDoublesPerTeam() {
    const counts = Array(teamCount).fill(0);
    pastSeasonDoubles.forEach((key) => {
      const [a, b] = unpackPairKey(key);
      counts[a]++;
      counts[b]++;
    });
    return counts;
  }

  function cellAvoidType(
    i: number,
    j: number,
  ): "manual" | "hard" | "soft" | "none" {
    const key = pairKey(i, j);
    if (manualDoubles.has(key)) return "manual";
    if (avoidSets.hard.has(key)) return "hard";
    if (avoidSets.soft.has(key)) return "soft";
    return "none";
  }

  return (
    <div className={cls.card}>
      <h2 className={cls.cardTitle}>{leagueName || "Review"}</h2>

      {history.length > 0 && (
        <div className="bg-slate-900 border border-slate-700 rounded-lg px-3.5 py-2.5 mb-4">
          <h3 className={cls.sectionTitle}>Lookback Window</h3>
          <select
            id="lookback-override"
            className="bg-slate-800 text-slate-200 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] outline-none focus:border-slate-500"
            value={effectiveLookbackTotal}
            onChange={(e) => {
              const next = parseInt(e.target.value, 10);
              patch({ lookbackOverride: next });
              saveToStorage({ lookbackOverride: next });
            }}
          >
            {Array.from(
              { length: Math.min(recommendedLookbackTotal, history.length) },
              (_, i) => i + 1,
            ).map((n) => (
              <option key={n} value={n}>
                {n === recommendedLookbackTotal ? `${n} (recommended)` : n}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] text-slate-500">
            <span className="text-red-400">
              {effectiveLookback.hard} hard season
              {effectiveLookback.hard === 1 ? "" : "s"}
            </span>
            {effectiveLookback.soft > 0 && (
              <>
                {" + "}
                <span className="text-amber-400">
                  {effectiveLookback.soft} soft season
                  {effectiveLookback.soft === 1 ? "" : "s"}
                </span>
              </>
            )}
          </p>
          {effectiveLookbackTotal !== recommendedLookbackTotal && (
            <p className="mt-1.5 text-[11px] text-slate-500">
              Recommended:{" "}
              <span className="text-amber-400">{recommendedLookbackTotal}</span>{" "}
              for {teamCount}-team / {weekCount}-week
            </p>
          )}
        </div>
      )}

      {history.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
            Season History ({history.length} saved)
          </summary>
          {[...history].reverse().map((h, displayIdx) => {
            const si = history.length - 1 - displayIdx;
            const age = history.length - si;
            const tone =
              age <= effectiveLookback.hard
                ? "text-red-400"
                : age <= effectiveLookback.hard + effectiveLookback.soft
                  ? "text-amber-400"
                  : "text-slate-600";
            const label =
              age <= effectiveLookback.hard
                ? "HARD AVOID"
                : age <= effectiveLookback.hard + effectiveLookback.soft
                  ? "SOFT AVOID"
                  : "ROTATED OUT";
            return (
              <div
                key={si}
                className="px-2 py-1.5 text-xs flex flex-wrap gap-2 items-center"
              >
                <strong className="text-slate-200">{h.season}</strong>
                <span className={`text-[10px] ${tone}`}>{label}</span>
                {h.format !== "userid" &&
                  (confirmDeleteSeasonIndex === si ? (
                    <span className="ml-auto flex gap-1">
                      <button
                        type="button"
                        className="bg-red-600 text-emerald-50 text-[10px] font-semibold px-1.5 py-0.5 border-0 rounded cursor-pointer hover:bg-red-500"
                        onClick={() => handleDeleteSeason(si)}
                      >
                        Yes, delete
                      </button>
                      <button
                        type="button"
                        className="bg-transparent text-[10px] text-slate-400 px-1.5 py-0.5 border border-slate-600 hover:border-slate-500 rounded cursor-pointer"
                        onClick={() =>
                          patch({ confirmDeleteSeasonIndex: null })
                        }
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="ml-auto flex gap-1">
                      <button
                        type="button"
                        className="bg-transparent text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 border border-amber-700 hover:border-amber-600 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => handleStartEditSeason(si)}
                        disabled={addingPastSeason}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="bg-transparent text-[10px] text-red-400 hover:text-red-300 px-1.5 py-0.5 border border-red-700 hover:border-red-600 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => patch({ confirmDeleteSeasonIndex: si })}
                        disabled={addingPastSeason}
                      >
                        Delete
                      </button>
                    </span>
                  ))}
              </div>
            );
          })}
        </details>
      )}

      {addingPastSeason ? (
        <div className={`${cls.subSection} mt-4`}>
          {showLookbackNote && (
            <p className="text-[11px] text-amber-400 mb-2">
              Additional seasons beyond the lookback window won&apos;t affect
              schedule generation.
            </p>
          )}
          <h3 className={cls.sectionTitle}>
            {editingSeasonIndex !== null
              ? "Edit Past Season"
              : "Add Past Season"}
          </h3>
          <p className={cls.hint}>
            {editingSeasonIndex !== null
              ? "Adjust which teams played each other twice this season."
              : "Select the year, then click each pair of teams that played twice that season."}
          </p>
          <div className="flex flex-wrap gap-2 items-center mb-3">
            <select
              className="bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 outline-none focus:border-slate-500 disabled:opacity-60 disabled:cursor-not-allowed"
              value={pastSeasonYear}
              onChange={(e) => patch({ pastSeasonYear: e.target.value })}
              disabled={editingSeasonIndex !== null}
            >
              {editingSeasonIndex !== null ? (
                <option value={pastSeasonYear}>{pastSeasonYear}</option>
              ) : (
                availablePastSeasonYears.map((y) => (
                  <option key={y} value={String(y)}>
                    {y}
                  </option>
                ))
              )}
            </select>
          </div>
          <div
            className="overflow-x-auto -mx-3.5 px-3.5"
            onScroll={() => hideHeaderTooltip()}
          >
            <div className="inline-block min-w-fit">
              <div className="flex sticky top-0 z-20">
                <div className="w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-mono font-semibold border border-slate-700 box-border sticky left-0 z-20" />
                {teams.map((t, i) => {
                  const inHoverCol = hoveredPastSeasonCell?.col === i;
                  return (
                    <div
                      key={i}
                      onMouseEnter={(e) => {
                        showHeaderTooltip(t, e.currentTarget);
                        patch({
                          hoveredPastSeasonCell: { row: -1, col: i },
                        });
                      }}
                      onMouseLeave={() => {
                        hideHeaderTooltip();
                        patch({ hoveredPastSeasonCell: null });
                      }}
                      className={`w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 flex items-center justify-center text-slate-500 text-[8px] font-mono font-semibold border border-slate-700 box-border overflow-hidden whitespace-nowrap ${inHoverCol ? "bg-slate-600" : "bg-slate-900"}`}
                    >
                      {abbrev(t)}
                    </div>
                  );
                })}
              </div>
              {teams.map((t, i) => (
                <div key={i} className="flex">
                  <div
                    onMouseEnter={(e) => {
                      showHeaderTooltip(t, e.currentTarget);
                      patch({
                        hoveredPastSeasonCell: { row: i, col: -1 },
                      });
                    }}
                    onMouseLeave={() => {
                      hideHeaderTooltip();
                      patch({ hoveredPastSeasonCell: null });
                    }}
                    className={`w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 flex items-center justify-center text-slate-500 text-[8px] font-mono font-semibold border border-slate-700 box-border sticky left-0 z-10 overflow-hidden whitespace-nowrap ${hoveredPastSeasonCell?.row === i ? "bg-slate-600" : "bg-slate-900"}`}
                  >
                    {abbrev(t)}
                  </div>
                  {teams.map((_, j) => {
                    const inHoverPath =
                      hoveredPastSeasonCell !== null &&
                      (hoveredPastSeasonCell.row === i ||
                        hoveredPastSeasonCell.col === j);
                    if (j === i) {
                      return (
                        <div
                          key={j}
                          className={`w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 font-mono border border-slate-700 box-border ${inHoverPath ? "bg-slate-800" : "bg-slate-950"}`}
                        />
                      );
                    }
                    const selected = pastSeasonDoubles.has(pairKey(i, j));
                    const bg = selected
                      ? inHoverPath
                        ? "bg-emerald-800"
                        : "bg-emerald-900"
                      : inHoverPath
                        ? "bg-slate-600"
                        : "bg-slate-800";
                    return (
                      <button
                        key={j}
                        type="button"
                        onMouseEnter={
                          canHover
                            ? (e) => {
                                showHeaderTooltip(
                                  `${teams[i]} vs ${teams[j]}`,
                                  e.currentTarget,
                                );
                                patch({
                                  hoveredPastSeasonCell: { row: i, col: j },
                                });
                              }
                            : undefined
                        }
                        onMouseLeave={
                          canHover
                            ? () => {
                                hideHeaderTooltip();
                                patch({ hoveredPastSeasonCell: null });
                              }
                            : undefined
                        }
                        onClick={() => togglePastSeasonDouble(i, j)}
                        className={`w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 flex items-center justify-center text-[10px] font-mono border border-slate-700 box-border select-none cursor-pointer ${bg} ${selected ? "text-emerald-400 font-bold" : "text-slate-500"}`}
                      >
                        {selected ? "✕" : ""}
                      </button>
                    );
                  })}
                </div>
              ))}
              {/* Per-team count of selected doubles. Neutral coloring on purpose - past seasons can come from a different format, so checking against the current format.doublesPerTeam would mis-flag valid entries. */}
              <div className="flex">
                <div className="w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-mono font-semibold border border-slate-700 box-border sticky left-0 z-10">
                  CT
                </div>
                {pastSeasonDoublesPerTeam().map((c, i) => {
                  const inHoverCol = hoveredPastSeasonCell?.col === i;
                  return (
                    <div
                      key={i}
                      className={`w-12 sm:w-[48px] min-w-[3rem] sm:min-w-[48px] h-7 flex items-center justify-center text-[8px] font-mono font-semibold border border-slate-700 box-border ${inHoverCol ? "bg-slate-600" : "bg-slate-900"} ${c === 0 ? "text-slate-600" : "text-slate-400"}`}
                    >
                      {c}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex gap-2 mt-3 flex-wrap">
            {pastSeasonDoubles.size > 0 && (
              <button
                className={`${cls.outlineBtn} ${cls.outlineAmber}`}
                onClick={() => patch({ pastSeasonDoubles: new Set() })}
              >
                Clear Selections
              </button>
            )}
            <button
              className={cls.secondaryBtn}
              onClick={handleCancelPastSeason}
            >
              Cancel
            </button>
            <button
              className={cls.primaryBtn}
              onClick={handleApplyPastSeason}
              disabled={!pastSeasonYear.trim()}
            >
              {editingSeasonIndex !== null ? "Update Season" : "Add Season"}
            </button>
          </div>
        </div>
      ) : availablePastSeasonYears.length > 0 ? (
        <div className="mt-4">
          <button
            className={`${cls.outlineBtn} ${cls.outlineEmerald}`}
            onClick={handleStartAddSeason}
          >
            + Add Past Season
          </button>
        </div>
      ) : null}

      {/* Matrix grid (horizontal scroll on mobile) */}
      <div
        className="overflow-x-auto -mx-2 px-2 mt-4"
        onScroll={() => hideHeaderTooltip()}
      >
        <div className="inline-block min-w-fit">
          <div className="flex sticky top-0 z-20">
            <div className="w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 flex items-center justify-center bg-slate-900 text-slate-500 text-[8px] font-mono font-semibold border border-slate-700 box-border sticky left-0 z-20" />
            {teams.map((t, i) => {
              const inHoverCol = hoveredAvoidCell?.col === i;
              return (
                <div
                  key={i}
                  onMouseEnter={(e) => {
                    showHeaderTooltip(t, e.currentTarget);
                    patch({ hoveredAvoidCell: { row: -1, col: i } });
                  }}
                  onMouseLeave={() => {
                    hideHeaderTooltip();
                    patch({ hoveredAvoidCell: null });
                  }}
                  className={`w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 flex items-center justify-center text-slate-500 text-[8px] font-mono font-semibold border border-slate-700 box-border overflow-hidden whitespace-nowrap ${inHoverCol ? "bg-slate-600" : "bg-slate-900"}`}
                >
                  {abbrev(t)}
                </div>
              );
            })}
          </div>
          {teams.map((t, i) => (
            <div key={i} className="flex">
              <div
                onMouseEnter={(e) => {
                  showHeaderTooltip(t, e.currentTarget);
                  patch({ hoveredAvoidCell: { row: i, col: -1 } });
                }}
                onMouseLeave={() => {
                  hideHeaderTooltip();
                  patch({ hoveredAvoidCell: null });
                }}
                className={`w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 flex items-center justify-center text-slate-500 text-[8px] font-mono font-semibold border border-slate-700 box-border sticky left-0 z-10 overflow-hidden whitespace-nowrap ${hoveredAvoidCell?.row === i ? "bg-slate-600" : "bg-slate-900"}`}
              >
                {abbrev(t)}
              </div>
              {teams.map((_, j) => {
                const inHoverPath =
                  hoveredAvoidCell !== null &&
                  (hoveredAvoidCell.row === i || hoveredAvoidCell.col === j);
                if (j === i) {
                  return (
                    <div
                      key={j}
                      className={`w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 font-mono border border-slate-700 box-border ${inHoverPath ? "bg-slate-800" : "bg-slate-950"}`}
                    />
                  );
                }
                const at = cellAvoidType(i, j);
                const isManual = manualDoubles.has(pairKey(i, j));
                const isLocked = at === "hard" || at === "soft";
                let bg: string;
                let textCls = "text-slate-500";
                let glyph = "";
                if (isManual) {
                  bg = inHoverPath ? "bg-purple-800" : "bg-purple-900";
                  textCls = "text-purple-400 font-bold";
                  glyph = "✕";
                } else if (at === "hard") {
                  bg = inHoverPath ? "bg-red-900" : "bg-red-950";
                  textCls = "text-red-400 font-bold";
                  glyph = "H";
                } else if (at === "soft") {
                  bg = inHoverPath ? "bg-amber-800" : "bg-amber-900";
                  textCls = "text-amber-400 font-semibold";
                  glyph = "S";
                } else {
                  bg = inHoverPath ? "bg-slate-600" : "bg-slate-800";
                }
                const cellDisabled = isLocked || addingPastSeason;
                return (
                  <button
                    key={j}
                    type="button"
                    onMouseEnter={
                      canHover
                        ? (e) => {
                            showHeaderTooltip(
                              `${teams[i]} vs ${teams[j]}`,
                              e.currentTarget,
                            );
                            patch({ hoveredAvoidCell: { row: i, col: j } });
                          }
                        : undefined
                    }
                    onMouseLeave={
                      canHover
                        ? () => {
                            hideHeaderTooltip();
                            patch({ hoveredAvoidCell: null });
                          }
                        : undefined
                    }
                    onClick={() => {
                      if (!cellDisabled) toggleDouble(i, j);
                    }}
                    aria-disabled={cellDisabled || undefined}
                    className={`w-12 sm:w-[50px] min-w-[3rem] sm:min-w-[50px] h-7 flex items-center justify-center text-[10px] font-mono border border-slate-700 box-border select-none ${cellDisabled ? "cursor-default" : "cursor-pointer"} ${bg} ${textCls}`}
                  >
                    {glyph}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <p className="text-[10px] text-slate-500 mt-2">
        <span className="text-purple-400">✕</span> manual avoid
        {effectiveLookback.hard > 0 && (
          <>
            {"  "}
            <span className="text-red-400">H</span> hard avoid (last{" "}
            {effectiveLookback.hard} season
            {effectiveLookback.hard !== 1 ? "s" : ""})
          </>
        )}
        {effectiveLookback.soft > 0 && (
          <>
            {"  "}
            <span className="text-amber-400">S</span> soft avoid (next{" "}
            {effectiveLookback.soft} season
            {effectiveLookback.soft !== 1 ? "s" : ""})
          </>
        )}
      </p>

      {manualDoubles.size > 0 && (
        <div className="mt-3">
          {confirmClearManualDoubles ? (
            <div className="flex gap-2 items-center flex-wrap">
              <span className="text-[11px] text-red-400">
                Clear all manual avoids?
              </span>
              <button
                type="button"
                className={`${cls.outlineBtn} bg-red-600 text-emerald-50 border-0 font-semibold hover:bg-red-500`}
                onClick={() =>
                  patch({
                    manualDoubles: new Set(),
                    confirmClearManualDoubles: false,
                  })
                }
              >
                Yes, clear
              </button>
              <button
                type="button"
                className={`${cls.outlineBtn} border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-300`}
                onClick={() => patch({ confirmClearManualDoubles: false })}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              className={`${cls.outlineBtn} ${cls.outlineAmber}`}
              onClick={() => patch({ confirmClearManualDoubles: true })}
              disabled={addingPastSeason}
            >
              Clear Manual Avoids
            </button>
          )}
        </div>
      )}

      {/* Per-team summary below the matrix - collapsed by default. Hidden entirely when no team has any avoidance so the section doesn't expand to empty. */}
      {(manualDoubles.size > 0 ||
        avoidSets.hard.size > 0 ||
        avoidSets.soft.size > 0) && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-slate-400 py-1.5 select-none hover:text-slate-300">
            Avoidance by Team
          </summary>
          <div className="mt-2 flex flex-col gap-1">
            {[...teams.entries()]
              .sort((a, b) =>
                a[1].localeCompare(b[1], undefined, { numeric: true }),
              )
              .map(([i, t]) => {
                const partners: {
                  name: string;
                  tone: string;
                  sortKey: number;
                  years?: string[];
                }[] = [];
                for (let j = 0; j < teamCount; j++) {
                  if (j === i) continue;
                  const at = cellAvoidType(i, j);
                  const isManual = manualDoubles.has(pairKey(i, j));
                  if (isManual) {
                    partners.push({
                      name: teams[j]!,
                      tone: "text-purple-400",
                      sortKey: 0,
                    });
                  } else if (at === "hard") {
                    partners.push({
                      name: teams[j]!,
                      tone: "text-red-400",
                      sortKey: 1,
                      years: avoidSets.seasons.get(pairKey(i, j)),
                    });
                  } else if (at === "soft") {
                    partners.push({
                      name: teams[j]!,
                      tone: "text-amber-400",
                      sortKey: 2,
                      years: avoidSets.seasons.get(pairKey(i, j)),
                    });
                  }
                }
                if (partners.length === 0) return null;
                partners.sort((a, b) => {
                  if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
                  // seasons years are most-recent-first, so [0] is the latest;
                  // within a tier, order by most recent avoidance, then name.
                  const aYear = a.years?.[0];
                  const bYear = b.years?.[0];
                  if (aYear && bYear && aYear !== bYear) {
                    return bYear.localeCompare(aYear, undefined, {
                      numeric: true,
                    });
                  }
                  return a.name.localeCompare(b.name);
                });
                return (
                  <div
                    key={i}
                    className="text-xs px-2 py-1 bg-slate-900 rounded"
                  >
                    <div className="text-slate-200 font-semibold">{t}</div>
                    <div>
                      {partners.map((p, k) => (
                        <span key={k}>
                          {k > 0 ? ", " : ""}
                          <span className={p.tone}>{p.name}</span>
                          {p.years && p.years.length > 0 && (
                            <>
                              {" "}
                              <span className="text-slate-500">
                                {`(${p.years.join(", ")})`}
                              </span>
                            </>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
          </div>
        </details>
      )}

      <RivalryPinBuilder
        teams={teams}
        teamCount={teamCount}
        weekCount={weekCount}
        format={format}
        rivalryPins={rivalryPins}
        pinTeamA={pinTeamA}
        pinTeamB={pinTeamB}
        pinWeek={pinWeek}
        pinJustAdded={pinJustAdded}
        addingPastSeason={addingPastSeason}
        confirmClearRivalryPins={confirmClearRivalryPins}
        confirmRemovePinIndex={confirmRemovePinIndex}
        mergedAvoidSets={mergedAvoidSets}
        patch={patch}
      />

      <div className="flex gap-3 mt-6 flex-wrap justify-center">
        <button
          className={cls.primaryBtn}
          onClick={onGenerate}
          disabled={addingPastSeason}
        >
          Generate Schedule →
        </button>
      </div>
      {genError && <p className={cls.error}>{genError}</p>}
    </div>
  );
}

type RivalryPinBuilderProps = {
  teams: string[];
  teamCount: number;
  weekCount: number;
  format: FormatProperties;
  rivalryPins: RivalryPin[];
  pinTeamA: number;
  pinTeamB: number;
  pinWeek: number | null;
  pinJustAdded: boolean;
  addingPastSeason: boolean;
  confirmClearRivalryPins: boolean;
  confirmRemovePinIndex: number | null;
  mergedAvoidSets: AvoidSets;
  patch: Patch;
};

function RivalryPinBuilder(props: RivalryPinBuilderProps) {
  const {
    teams,
    teamCount,
    weekCount,
    format,
    rivalryPins,
    pinTeamA,
    pinTeamB,
    pinWeek,
    pinJustAdded,
    addingPastSeason,
    confirmClearRivalryPins,
    confirmRemovePinIndex,
    mergedAvoidSets,
    patch,
  } = props;

  // Derive valid team indices. safeB is forced to differ from safeA
  // so the dropdown can never silently render an invalid same-team
  // pair; the Team B option matching safeA is also explicitly disabled.
  const safeA = pinTeamA < teamCount ? pinTeamA : 0;
  const safeBCandidate =
    pinTeamB < teamCount ? pinTeamB : Math.min(1, Math.max(0, teamCount - 1));
  const safeB =
    safeBCandidate === safeA
      ? safeA === 0
        ? Math.min(1, teamCount - 1)
        : 0
      : safeBCandidate;
  const pinAKey = pairKey(safeA, safeB);
  const sameTeam = safeA === safeB;
  const maxPinsPerPair = Math.max(
    1,
    Math.ceil(weekCount / Math.max(1, teamCount - 1)),
  );
  const existingPinsForPair = rivalryPins.filter(
    (p) => pairKey(p.teamA, p.teamB) === pinAKey,
  ).length;
  const pairAtMax = existingPinsForPair >= maxPinsPerPair;

  // In dp=1 formats (e.g. 14/14) each team has exactly one doubled
  // partner, so a 2-pin pair MUST sit at natural-partner weeks (W
  // and W ± separation). If the pair already has one specific-week
  // pin, the only valid second-pin week is that partner — every
  // other week would force a structurally infeasible non-partner
  // double.
  const partnerOnlyWeek: number | null = (() => {
    if (!format || format.doublesPerTeam !== 1) return null;
    if (existingPinsForPair !== 1) return null;
    const existing = rivalryPins.find(
      (p) => pairKey(p.teamA, p.teamB) === pinAKey,
    );
    if (!existing || existing.week === null) return null;
    const sep = format.separation;
    const up = existing.week + sep;
    const down = existing.week - sep;
    if (up >= 1 && up <= weekCount) return up;
    if (down >= 1 && down <= weekCount) return down;
    return null;
  })();

  // When the pair's existing pin sits on a week whose natural
  // partner (W ± separation) falls outside [1, weekCount], the
  // second specific-week pin has no in-range partner — any
  // specific week the user picks creates a non-partner double
  // that the algorithm rejects at generation time. Block adding
  // a second specific-week pin in this state; "Any" still lets
  // the algorithm route the rematch.
  const existingPinForPair =
    existingPinsForPair === 1
      ? (rivalryPins.find((p) => pairKey(p.teamA, p.teamB) === pinAKey) ?? null)
      : null;
  const noPartnerWeekForPair: boolean =
    !!format &&
    format.doublesPerTeam === 1 &&
    !!existingPinForPair &&
    existingPinForPair.week !== null &&
    existingPinForPair.week + format.separation > weekCount &&
    existingPinForPair.week - format.separation < 1;

  // Per-week option state. Order matters: an exact-pair duplicate
  // takes priority over the generic team-conflict label.
  const weekOptionState = (
    W: number,
  ): { disabled: boolean; suffix: string } => {
    const exactDup = rivalryPins.some(
      (p) => p.week === W && pairKey(p.teamA, p.teamB) === pinAKey,
    );
    if (exactDup) return { disabled: true, suffix: " (already pinned)" };
    const teamConflict = rivalryPins.some(
      (p) =>
        p.week === W &&
        (p.teamA === safeA ||
          p.teamB === safeA ||
          p.teamA === safeB ||
          p.teamB === safeB),
    );
    if (teamConflict) return { disabled: true, suffix: " (pinned)" };
    if (noPartnerWeekForPair) {
      return { disabled: true, suffix: " (unavailable)" };
    }
    if (partnerOnlyWeek !== null && W !== partnerOnlyWeek) {
      return { disabled: true, suffix: " (unavailable)" };
    }
    return { disabled: false, suffix: "" };
  };

  const pinWeekDisabled =
    pinWeek === null ? pairAtMax : weekOptionState(pinWeek).disabled;

  // Fallback inline validation. The smart disabling above prevents
  // most invalid selections from being made; this catches stale
  // state (e.g., a week selected before the teams were changed).
  let pinError = "";
  if (sameTeam) {
    pinError = "Pick two different teams.";
  }
  // Same team, same week (different opponent). Stricter and more
  // informative than the per-week conflict loop below, which still
  // runs as a fallback.
  if (!pinError && pinWeek !== null) {
    for (const p of rivalryPins) {
      if (p.week !== pinWeek) continue;
      if (pairKey(p.teamA, p.teamB) === pinAKey) continue;
      let conflictedIdx = -1;
      let opponentIdx = -1;
      if (p.teamA === safeA || p.teamB === safeA) {
        conflictedIdx = safeA;
        opponentIdx = p.teamA === safeA ? p.teamB : p.teamA;
      } else if (p.teamA === safeB || p.teamB === safeB) {
        conflictedIdx = safeB;
        opponentIdx = p.teamA === safeB ? p.teamB : p.teamA;
      }
      if (conflictedIdx >= 0) {
        pinError =
          `Team ${teams[conflictedIdx]} is already pinned to Week ${pinWeek} against ${teams[opponentIdx]}. ` +
          "A team can only play once per week.";
        break;
      }
    }
  }
  // Too many doubles for one team. Counts distinct pinned opponents
  // per team across all pins (including "Any"). A second pin for the
  // same pair doesn't add a new opponent, so it's allowed.
  if (!pinError && format) {
    const opponentsOf = (team: number) => {
      const set = new Set<number>();
      for (const p of rivalryPins) {
        if (p.teamA === team) set.add(p.teamB);
        else if (p.teamB === team) set.add(p.teamA);
      }
      return set;
    };
    const maxDoubles = format.doublesPerTeam;
    const oppA = opponentsOf(safeA);
    if (!oppA.has(safeB) && oppA.size >= maxDoubles) {
      pinError = `${teams[safeA]} is already pinned against ${oppA.size} different opponents - this format supports at most ${maxDoubles} repeat opponents per team.`;
    } else {
      const oppB = opponentsOf(safeB);
      if (!oppB.has(safeA) && oppB.size >= maxDoubles) {
        pinError = `${teams[safeB]} is already pinned against ${oppB.size} different opponents - this format supports at most ${maxDoubles} repeat opponents per team.`;
      }
    }
  }
  // Too many matchups in one week. A full week is teamCount / 2.
  if (!pinError && pinWeek !== null) {
    const matchupsInWeek = rivalryPins.filter((p) => p.week === pinWeek).length;
    const fullWeek = Math.floor(teamCount / 2);
    if (matchupsInWeek >= fullWeek) {
      pinError = `Week ${pinWeek} already has ${matchupsInWeek} matchups pinned - that fills the entire week.`;
    }
  }
  if (!pinError && pairAtMax) {
    pinError = `This pair can play at most ${maxPinsPerPair} time${
      maxPinsPerPair === 1 ? "" : "s"
    } in this format.`;
  }
  if (
    !pinError &&
    pinWeek !== null &&
    (noPartnerWeekForPair ||
      (partnerOnlyWeek !== null && pinWeek !== partnerOnlyWeek))
  ) {
    pinError =
      partnerOnlyWeek !== null
        ? `This format only allows the rematch in Week ${partnerOnlyWeek}. ` +
          "Use 'Any' to let the algorithm place it automatically."
        : "No valid week available for a second pin in this format. " +
          "Use 'Any' to let the algorithm place the rematch.";
  }
  if (!pinError && pinWeek !== null) {
    for (const p of rivalryPins) {
      if (p.week !== pinWeek) continue;
      const conflictA = p.teamA === safeA || p.teamB === safeA;
      const conflictB = p.teamA === safeB || p.teamB === safeB;
      if (conflictA || conflictB) {
        const conflictedIdx = conflictA ? safeA : safeB;
        pinError = `${teams[conflictedIdx]} is already pinned to Week ${pinWeek}.`;
        break;
      }
    }
    if (!pinError) {
      const dupExists = rivalryPins.some(
        (p) => p.week === pinWeek && pairKey(p.teamA, p.teamB) === pinAKey,
      );
      if (dupExists) pinError = "This matchup is already pinned to this week.";
    }
  }
  // Avoid warning is informational about the current selection; it
  // stays visible whenever the pair is avoided, regardless of any
  // active pinError or the post-add suppression flag.
  let avoidWarning = "";
  let avoidWarningTone = "text-amber-400";
  {
    const { hard, soft } = mergedAvoidSets;
    if (hard.has(pinAKey)) {
      avoidWarning =
        "This pair is hard-avoided. This pin forces one game between them - they won't play again.";
      avoidWarningTone = "text-red-400";
    } else if (soft.has(pinAKey)) {
      avoidWarning =
        "This pair is soft-avoided. This pin forces one game between them.";
      avoidWarningTone = "text-amber-400";
    }
  }
  const addDisabled = !!pinError || addingPastSeason || pinWeekDisabled;

  return (
    <div className={`${cls.subSection} mt-4`}>
      <h3 className={cls.sectionTitle}>Rivalry Weeks</h3>
      <p className={cls.hint}>
        Pick two teams and a week to lock in a matchup. Pins show in blue.
      </p>
      <div className="flex flex-wrap gap-2 items-stretch">
        <select
          aria-label="Week"
          className="w-full sm:w-auto bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 outline-none focus:border-slate-500"
          value={pinWeek === null ? "any" : String(pinWeek)}
          onChange={(e) => {
            const v = e.target.value;
            patch({
              pinWeek: v === "any" ? null : parseInt(v, 10),
              pinJustAdded: false,
            });
          }}
        >
          <option value="any" disabled={pairAtMax}>
            Any week
          </option>
          {Array.from({ length: weekCount }, (_, i) => {
            const W = i + 1;
            const { disabled, suffix } = weekOptionState(W);
            return (
              <option key={W} value={String(W)} disabled={disabled}>
                Week {W}
                {suffix}
              </option>
            );
          })}
        </select>
        <select
          aria-label="First team"
          className="w-[calc(50%-0.25rem)] sm:w-auto sm:flex-1 sm:min-w-[8rem] bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 outline-none focus:border-slate-500"
          value={safeA}
          onChange={(e) => {
            const newA = Number(e.target.value);
            const nextTeamB =
              pinTeamB === newA
                ? newA === 0
                  ? Math.min(1, teamCount - 1)
                  : 0
                : pinTeamB;
            patch({
              pinTeamA: newA,
              pinTeamB: nextTeamB,
              pinJustAdded: false,
            });
          }}
        >
          {teams.map((t, i) => (
            <option key={i} value={i}>
              {t}
            </option>
          ))}
        </select>
        <select
          aria-label="Second team"
          className="w-[calc(50%-0.25rem)] sm:w-auto sm:flex-1 sm:min-w-[8rem] bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 outline-none focus:border-slate-500"
          value={safeB}
          onChange={(e) => {
            const newB = Number(e.target.value);
            patch({
              ...(newB !== safeA ? { pinTeamB: newB } : {}),
              pinJustAdded: false,
            });
          }}
        >
          {teams.map((t, i) => (
            <option key={i} value={i} disabled={i === safeA}>
              {t}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`${cls.primaryBtnBase} bg-sky-500 text-sky-50 hover:bg-sky-600 mx-auto sm:mx-0`}
          disabled={addDisabled}
          onClick={() => {
            if (addDisabled) return;
            const nextPins = [
              ...rivalryPins,
              { teamA: safeA, teamB: safeB, week: pinWeek },
            ];
            // Keep the week and advance both team defaults so the
            // next pin can fit without manual fiddling. Team A is
            // the lowest team still free in the kept week; Team B
            // is the lowest free team after that. Falls back to
            // 0 and 1 if no free teams remain that week.
            const isBusyInWeek = (t: number): boolean => {
              if (pinWeek === null) return false;
              return nextPins.some(
                (p) => p.week === pinWeek && (p.teamA === t || p.teamB === t),
              );
            };
            let nextA = 0;
            for (let i = 0; i < teamCount; i++) {
              if (!isBusyInWeek(i)) {
                nextA = i;
                break;
              }
            }
            let nextB = nextA === 0 ? 1 : 0;
            for (let i = nextA + 1; i < teamCount; i++) {
              if (!isBusyInWeek(i)) {
                nextB = i;
                break;
              }
            }
            patch({
              rivalryPins: nextPins,
              pinTeamA: nextA,
              pinTeamB: nextB,
              pinJustAdded: true,
            });
          }}
        >
          Pin
        </button>
      </div>
      {!pinJustAdded && pinError ? (
        <p className="text-[11px] mt-2 text-red-400">{pinError}</p>
      ) : avoidWarning ? (
        <p className={`text-[11px] mt-2 ${avoidWarningTone}`}>{avoidWarning}</p>
      ) : null}
      {rivalryPins.length > 0 && (
        <>
          <div className="mt-3 flex flex-col gap-1">
            {[...rivalryPins.entries()]
              .sort(([, a], [, b]) => {
                const aAny = a.week === null;
                const bAny = b.week === null;
                if (aAny !== bAny) return aAny ? 1 : -1;
                if (!aAny && !bAny && a.week !== b.week) {
                  return (a.week as number) - (b.week as number);
                }
                return teams[a.teamA]!.localeCompare(
                  teams[b.teamA]!,
                  undefined,
                  {
                    numeric: true,
                  },
                );
              })
              .map(([idx, p]) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 px-2 py-1 bg-slate-800 rounded text-xs border border-slate-700"
                >
                  <span className="flex-1 text-slate-200">
                    <span className="text-slate-500">
                      {p.week === null ? "Any week" : `Week ${p.week}`}
                      {" - "}
                    </span>
                    <span className="text-sky-400">{teams[p.teamA]}</span>
                    <span className="text-slate-500"> vs </span>
                    <span className="text-sky-400">{teams[p.teamB]}</span>
                  </span>
                  {confirmRemovePinIndex === idx ? (
                    <span className="flex gap-1">
                      <button
                        type="button"
                        className="bg-red-600 text-emerald-50 text-[10px] font-semibold px-1.5 py-0.5 border-0 rounded cursor-pointer hover:bg-red-500"
                        onClick={() =>
                          patch({
                            rivalryPins: rivalryPins.filter(
                              (_, i) => i !== idx,
                            ),
                            confirmRemovePinIndex: null,
                          })
                        }
                      >
                        Yes, remove
                      </button>
                      <button
                        type="button"
                        className="bg-transparent text-[10px] text-slate-400 px-1.5 py-0.5 border border-slate-600 hover:border-slate-500 rounded cursor-pointer"
                        onClick={() => patch({ confirmRemovePinIndex: null })}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="bg-transparent text-[10px] text-red-400 hover:text-red-300 px-1.5 py-0.5 border border-red-700 hover:border-red-600 rounded cursor-pointer"
                      onClick={() => patch({ confirmRemovePinIndex: idx })}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
          </div>
          <div className="mt-3">
            {confirmClearRivalryPins ? (
              <div className="flex gap-2 items-center flex-wrap">
                <span className="text-[11px] text-red-400">
                  Clear all rivalry pins?
                </span>
                <button
                  type="button"
                  className={`${cls.outlineBtn} bg-red-600 text-emerald-50 border-0 font-semibold hover:bg-red-500`}
                  onClick={() =>
                    patch({ rivalryPins: [], confirmClearRivalryPins: false })
                  }
                >
                  Yes, clear
                </button>
                <button
                  type="button"
                  className={`${cls.outlineBtn} border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-300`}
                  onClick={() => patch({ confirmClearRivalryPins: false })}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={`${cls.outlineBtn} ${cls.outlineAmber}`}
                onClick={() => patch({ confirmClearRivalryPins: true })}
                disabled={addingPastSeason}
              >
                Clear Rivalry Pins
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
