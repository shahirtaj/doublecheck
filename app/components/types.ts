import type { PairKey, SeasonHistory, RivalryPin } from "@/lib/algorithm";

export type SelectedFormat = { teamCount: number; weekCount: number };

export type ImportedSeasonRecord = {
  seasonYear?: string;
  seasonName?: string;
  teamNames: string[];
  userIds: (string | null)[];
  doubles: PairKey[];
  totalMatchups?: number;
  regWeeks?: number;
};

// A season the import route attempted but couldn't fetch (after its one
// retry). `season` is the year label ("2023") when the platform knows it,
// "" when it doesn't — gap withholding can only anchor on numeric years.
export type FailedImportSeason = { season: string; error: string };

export type ImportPlatform = "sleeper" | "espn" | "yahoo" | "manual";

// "link" is the dropdown value for restoring from a share URL. It is not
// stored or shared — when a restore succeeds, `platform` gets set from the
// share payload (with "manual" as the fallback for older links).
export type ImportSource = ImportPlatform | "link";

export type ImportPreview = {
  platform: ImportPlatform;
  seasons: ImportedSeasonRecord[];
};

// Hydratable subset of a fetched share payload — everything except the
// schedule itself. Restoring intentionally drops the old schedule so the
// user regenerates against current avoidance constraints on Step 3.
export type LinkPreview = {
  format: { teamCount: number; weekCount: number };
  teams: string[];
  userIds: (string | null)[];
  leagueName?: string;
  platform?: string;
  history?: SeasonHistory[];
  manualDoubles?: PairKey[];
  rivalryPins?: RivalryPin[];
};

export type ImportStatus = "" | "loading" | "ready" | "error";

export type YahooLeagueOption = {
  leagueKey: string;
  name: string;
  season: string;
  numTeams: number;
};

export type SleeperLeagueOption = {
  leagueId: string;
  name: string;
  season: string;
};

export type Step = "teams" | "doubles" | "schedule";
