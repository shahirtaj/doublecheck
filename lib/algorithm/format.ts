import type { FormatProperties, FormatVariant, LookbackWindow } from "./types";

// describeFormat derives every static property of a (teams, weeks) format:
// double/single counts, the maximum-separation week gap, the rotation cycle,
// and the lookback window used by buildAvoidMap.
export function describeFormat(teamCount: number, weekCount: number): FormatProperties {
  const opponents = teamCount - 1;
  const doublesPerTeam = weekCount - opponents;
  const singlesPerTeam = opponents - doublesPerTeam;

  const variant: FormatVariant =
    doublesPerTeam <= 0
      ? "pure-round-robin"
      : singlesPerTeam <= 0
        ? "complete-double-round-robin"
        : doublesPerTeam > singlesPerTeam
          ? "inverted"
          : "standard";

  const rotationCycle = computeRotationCycle(opponents, doublesPerTeam, singlesPerTeam);
  const lookback = computeLookback(doublesPerTeam, singlesPerTeam);

  return {
    teamCount,
    weekCount,
    doublesPerTeam: Math.max(0, doublesPerTeam),
    singlesPerTeam: Math.max(0, singlesPerTeam),
    doubleMatchingsCount: Math.max(0, doublesPerTeam),
    singleMatchingsCount: Math.max(0, singlesPerTeam),
    separation: doublesPerTeam > 0 ? weekCount - doublesPerTeam : 0,
    rotationCycle,
    lookback,
    variant,
  };
}

// The rotation cycle measures how many seasons until the binding side of the
// schedule (whichever is scarcer per season — doubled or single opponents) has
// rotated through every opponent. For severely inverted formats with only one
// single per team, the singles side is binding (you cycle through who is the
// single opponent). Otherwise the doubled set is binding.
function computeRotationCycle(opponents: number, doubles: number, singles: number): number {
  if (doubles <= 0) return 0;
  if (singles <= 0) return 1;
  if (singles === 1) return opponents;
  return Math.ceil(opponents / doubles);
}

// Maximum hard-avoid lookback that leaves room to still place this year's
// doubles given the format. Specifically, after k seasons of disjoint doubles,
// each team has k * doubles forbidden opponents; we need at least `doubles`
// unforbidden opponents remaining, so k <= floor(singles / doubles).
function computeLookback(doubles: number, singles: number): LookbackWindow {
  if (doubles <= 0 || singles <= 0) return { hard: 0, soft: 0 };
  const hard = Math.floor(singles / doubles);
  return { hard, soft: 1 };
}
