import type {
  PairKey,
  RivalryPin,
  ScheduleSuccess,
  SeasonHistory,
} from "@/lib/algorithm";
import { CURRENT_YEAR_STR } from "./constants";
import type {
  ImportPlatform,
  ImportPreview,
  ImportSource,
  ImportStatus,
  LinkPreview,
  SelectedFormat,
  SleeperLeagueOption,
  Step,
  YahooLeagueOption,
} from "./types";

export type ShareStatus = "idle" | "loading" | "ready" | "error";

export type State = {
  step: Step;
  furthestStep: Step;
  selectedFormat: SelectedFormat | null;
  // Baseline for the import flow's formatChanged decision. Back clears
  // selectedFormat to re-enter the import UI but leaves teams/history loaded;
  // this keeps the cleared format so a re-import can tell "same league shape,
  // merge into existing history" from "format change, drop it". Ephemeral —
  // a reload hydrates selectedFormat directly, so this never needs persisting.
  priorFormat: SelectedFormat | null;
  teams: string[];
  userIds: (string | null)[];
  leagueName: string;
  manualDoubles: Set<PairKey>;
  rivalryPins: RivalryPin[];
  pinTeamA: number;
  pinTeamB: number;
  pinWeek: number | null;
  pinJustAdded: boolean;
  schedule: ScheduleSuccess | null;
  displayWeeks: [number, number][][] | null;
  history: SeasonHistory[];
  lookbackOverride: number | null;
  loading: boolean;
  genError: string;
  selectedWeek: number;
  saved: boolean;
  confirmReset: boolean;
  confirmClearManualDoubles: boolean;
  confirmClearRivalryPins: boolean;
  confirmClearSelections: boolean;
  confirmRemovePinIndex: number | null;
  shareStatus: ShareStatus;
  shareUrl: string;
  shareError: string;
  shareCopied: boolean;
  scheduleCopied: boolean;
  platform: ImportPlatform;
  importSource: ImportSource;
  leagueId: string;
  shareLinkInput: string;
  linkPreview: LinkPreview | null;
  importStatus: ImportStatus;
  importMsg: string;
  importHelpUrl: string | null;
  importPreview: ImportPreview | null;
  yahooLeagues: YahooLeagueOption[] | null;
  selectedYahooLeague: string;
  sleeperLeagues: SleeperLeagueOption[] | null;
  selectedSleeperLeague: string;
  manualLeagueName: string;
  manualTeamCount: number;
  manualWeekCount: number;
  addingPastSeason: boolean;
  pastSeasonYear: string;
  pastSeasonDoubles: Set<PairKey>;
  editingSeasonIndex: number | null;
  confirmDeleteSeasonIndex: number | null;
  tooltipInfo: { text: string; rect: DOMRect } | null;
  hoveredAvoidCell: { row: number; col: number } | null;
  hoveredPastSeasonCell: { row: number; col: number } | null;
  canHover: boolean;
  // Bridge between the Yahoo OAuth callback handler (which lives in page.tsx)
  // and the fetchYahooLeagues helper (which lives inside StepImport). The
  // OAuth useEffect sets this flag, StepImport watches for it, calls the
  // fetch, then clears the flag.
  pendingYahooConnect: boolean;
};

export const initialState: State = {
  step: "teams",
  furthestStep: "teams",
  selectedFormat: null,
  priorFormat: null,
  teams: [],
  userIds: [],
  leagueName: "",
  manualDoubles: new Set(),
  rivalryPins: [],
  pinTeamA: 0,
  pinTeamB: 1,
  pinWeek: null,
  pinJustAdded: false,
  schedule: null,
  displayWeeks: null,
  history: [],
  lookbackOverride: null,
  loading: true,
  genError: "",
  selectedWeek: 0,
  saved: false,
  confirmReset: false,
  confirmClearManualDoubles: false,
  confirmClearRivalryPins: false,
  confirmClearSelections: false,
  confirmRemovePinIndex: null,
  shareStatus: "idle",
  shareUrl: "",
  shareError: "",
  shareCopied: false,
  scheduleCopied: false,
  platform: "sleeper",
  importSource: "sleeper",
  leagueId: "",
  shareLinkInput: "",
  linkPreview: null,
  importStatus: "",
  importMsg: "",
  importHelpUrl: null,
  importPreview: null,
  yahooLeagues: null,
  selectedYahooLeague: "",
  sleeperLeagues: null,
  selectedSleeperLeague: "",
  manualLeagueName: "",
  manualTeamCount: 12,
  manualWeekCount: 14,
  addingPastSeason: false,
  pastSeasonYear: CURRENT_YEAR_STR,
  pastSeasonDoubles: new Set(),
  editingSeasonIndex: null,
  confirmDeleteSeasonIndex: null,
  tooltipInfo: null,
  hoveredAvoidCell: null,
  hoveredPastSeasonCell: null,
  canHover: false,
  pendingYahooConnect: false,
};

export type Action =
  | { type: "patch"; patch: Partial<State> }
  | { type: "reset" };

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "patch":
      return { ...state, ...action.patch };
    case "reset":
      // The reset button is exposed only after hydration, so loading stays
      // false; everything else returns to defaults.
      return { ...initialState, loading: false };
  }
}

export type Patch = (p: Partial<State>) => void;

export type SaveToStorageExtra = Partial<{
  teams: string[];
  userIds: (string | null)[];
  history: SeasonHistory[];
  manualDoubles: PairKey[];
  rivalryPins: RivalryPin[];
  format: SelectedFormat | null;
  lookbackOverride: number | null;
  leagueName: string;
  platform: ImportPlatform;
}>;

export type SaveToStorageFn = (extra?: SaveToStorageExtra) => void;
