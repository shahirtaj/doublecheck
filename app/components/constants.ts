export const STORAGE_KEY = "ff-rotational-scheduler";
export const STEP_ORDER = ["teams", "doubles", "schedule"] as const;
// Captured once at module load and reused for every "current year" default
// and reset throughout the component (`PAST_SEASON_YEARS` is derived from
// these inside the component so it can size itself to the active format).
export const CURRENT_YEAR = new Date().getFullYear();
export const CURRENT_YEAR_STR = String(CURRENT_YEAR);
