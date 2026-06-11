export const STORAGE_KEY = "ff-rotational-scheduler";
export const STEP_ORDER = ["teams", "doubles", "schedule"] as const;
// Captured once at module load and reused for every "current year" default
// and reset throughout the component (`PAST_SEASON_YEARS` is derived from
// these inside the component so it can size itself to the active format).
export const CURRENT_YEAR = new Date().getFullYear();
export const CURRENT_YEAR_STR = String(CURRENT_YEAR);
// Seasons to request from an import route when the league's format isn't
// known yet (a fresh import - detection needs the response). Enough for any
// supported format: the largest recommended lookback is 13 prior seasons
// (14-team / 14-week), plus the newest season that anchors detection - which
// for a mid-season Sleeper import is the in-progress year and doesn't count
// toward prior-season avoidance. Matches MAX_SEASONS_CAP in the import
// routes; keep them in sync.
export const MAX_IMPORT_SEASONS = 14;
// Generate's auto-retry budget. Tight-but-satisfiable pin configurations
// succeed ~20-25% per attempt with 65-250ms failures (desktop; assume a few
// times slower on mobile), so ~2.5s of retries makes them essentially always
// work while bounding the truly infeasible sets. The attempt cap keeps
// fast-failing deterministic cases (which retry uselessly but harmlessly)
// from spinning hundreds of yields inside the wall-clock budget.
export const GENERATE_RETRY_BUDGET_MS = 2500;
export const GENERATE_RETRY_MAX_ATTEMPTS = 40;
