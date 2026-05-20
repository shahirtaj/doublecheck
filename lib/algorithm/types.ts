// Shared types for the scheduling algorithm.

// A matchup between two team indices, stored sorted as [min, max].
export type Pair = [number, number];

// One round of play: a perfect matching of all teams into pairs.
export type Matching = Pair[];

// "i-j" with i < j. Used as the canonical key for a pair across Sets/Maps.
export type PairKey = string;

// How many of last year's doubles to forbid (hard) vs. deprioritize (soft).
export type LookbackWindow = {
  hard: number;
  soft: number;
};

// Shape and rotational properties of a (teamCount, weekCount) format.
export type FormatVariant =
  | "pure-round-robin"
  | "complete-double-round-robin"
  | "standard"
  | "inverted";

export type FormatProperties = {
  teamCount: number;
  weekCount: number;
  doublesPerTeam: number;
  singlesPerTeam: number;
  doubleMatchingsCount: number;
  singleMatchingsCount: number;
  // Weeks between the two appearances of any doubled pair (= weekCount - doublesPerTeam).
  separation: number;
  // Years until the rotation completes one full cycle for the format's binding side.
  rotationCycle: number;
  lookback: LookbackWindow;
  variant: FormatVariant;
};

// A commissioner-supplied "rivalry week" constraint: pin a specific matchup to
// a specific week, or to any week (the algorithm picks). Team indices are
// 0-based into the current roster; week is 1-indexed to match the UI, or null
// for "any week".
export type RivalryPin = {
  teamA: number;
  teamB: number;
  week: number | null;
};

// Where a rivalry pin ended up. `pinnedWeek` is what the user specified
// (null = "any"); `placedWeek` is the 1-indexed week the algorithm assigned
// (equal to pinnedWeek for specific-week pins; chosen by the algorithm for
// any-week pins).
export type RivalryPlacement = {
  teamA: number;
  teamB: number;
  pinnedWeek: number | null;
  placedWeek: number;
};

export type ScheduleConfig = {
  teamCount: number;
  weekCount: number;
  // Pairs that MUST NOT be doubled (e.g., last 1-2 seasons' doubles).
  hardAvoid?: ReadonlySet<PairKey>;
  // Pairs that should be doubled only if no alternative exists.
  softAvoid?: ReadonlySet<PairKey>;
  // Commissioner-pinned matchups. Pinned pairs override hardAvoid/softAvoid.
  rivalryPins?: ReadonlyArray<RivalryPin>;
  // Injectable RNG for deterministic tests. Defaults to Math.random.
  random?: () => number;
};

export type ScheduleSuccess = {
  ok: true;
  // Length === weekCount. Each entry is a perfect matching for that week.
  weeks: Matching[];
  // The pair keys that appear in two weeks.
  doubledPairs: Set<PairKey>;
  // softAvoid pairs that ended up doubled (allowed but tracked).
  softRepeated: PairKey[];
  // hardAvoid pairs that ended up doubled (only possible if Tier 1 was infeasible
  // — currently never, since we fail rather than violate hard avoid).
  hardRepeated: PairKey[];
  // True if we found doubles avoiding both hard AND soft sets.
  clean: boolean;
  format: FormatProperties;
  // Where each commissioner pin landed (empty when no pins supplied).
  rivalryPlacements: ReadonlyArray<RivalryPlacement>;
};

// Format does not need a generated schedule (pure RR or complete double RR).
export type ScheduleSkipped = {
  ok: false;
  reason: "pure-round-robin" | "complete-double-round-robin";
  message: string;
  format: FormatProperties;
};

// Input was malformed or constraints were infeasible.
export type ScheduleFailure = {
  ok: false;
  reason: "invalid-format" | "generation-failed";
  message: string;
};

export type ScheduleResult = ScheduleSuccess | ScheduleSkipped | ScheduleFailure;

// Identity format used to record a season's doubles for future avoidance.
// "index": pair keys are "i-j" referring to team indices in this season's roster.
// "userid": pair keys are "uid1:uid2" referring to platform user IDs.
export type SeasonIdentityFormat = "index" | "userid";

export type SeasonHistory = {
  season: string;
  doubles: PairKey[];
  format?: SeasonIdentityFormat;
};
