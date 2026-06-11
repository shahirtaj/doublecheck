// Public surface of the scheduling algorithm.

export { buildSchedule, overAvoidedTeams } from "./schedule";
export { describeFormat } from "./format";
export { buildAvoidMap } from "./avoid";
export type { AvoidMap } from "./avoid";
export { pairKey, unpackPairKey } from "./pair";

export type {
  Pair,
  Matching,
  PairKey,
  RivalryPin,
  RivalryPlacement,
  ScheduleConfig,
  ScheduleResult,
  ScheduleSuccess,
  ScheduleSkipped,
  ScheduleFailure,
  FormatProperties,
  FormatVariant,
  LookbackWindow,
  SeasonHistory,
  SeasonIdentityFormat,
} from "./types";
