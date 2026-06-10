// Validation for the share POST payload, in a sibling module so it can be
// unit-tested directly (Next.js route files may only export route handlers).

export const MAX_TEAM_COUNT = 32;
export const MAX_TEAM_NAME_LENGTH = 64;
export const MAX_LEAGUE_NAME_LENGTH = 128;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function validatePayload(body: unknown): string | null {
  if (!isPlainObject(body)) return "Body must be an object.";

  const format = body.format;
  if (!isPlainObject(format)) return "Missing format.";
  if (
    typeof format.teamCount !== "number" ||
    typeof format.weekCount !== "number" ||
    !Number.isInteger(format.teamCount) ||
    !Number.isInteger(format.weekCount)
  ) {
    return "format.teamCount and format.weekCount must be integers.";
  }
  // Mirror lib/algorithm's validate(): only even round-robin shapes are
  // schedulable. Not restricted to the 7 supported formats - import
  // auto-detection intentionally allows other even shapes. The 32 cap just
  // bounds payload size.
  if (
    format.teamCount < 2 ||
    format.teamCount % 2 !== 0 ||
    format.teamCount > MAX_TEAM_COUNT
  ) {
    return `format.teamCount must be an even integer between 2 and ${MAX_TEAM_COUNT}.`;
  }
  if (
    format.weekCount < format.teamCount - 1 ||
    format.weekCount > 2 * (format.teamCount - 1)
  ) {
    return "format.weekCount must be between teamCount - 1 and 2 * (teamCount - 1).";
  }
  const teamCount = format.teamCount;

  if (!Array.isArray(body.teams)) return "teams must be an array.";
  if (body.teams.length !== teamCount) {
    return "teams length must match format.teamCount.";
  }
  // Empty names are allowed (the UI permits them); the length cap is well
  // above the UI's 24-char limit, just bounding hand-crafted payloads.
  if (
    !body.teams.every(
      (t) => typeof t === "string" && t.length <= MAX_TEAM_NAME_LENGTH,
    )
  ) {
    return `teams must be strings of at most ${MAX_TEAM_NAME_LENGTH} characters.`;
  }

  if (body.leagueName !== undefined) {
    if (
      typeof body.leagueName !== "string" ||
      body.leagueName.length > MAX_LEAGUE_NAME_LENGTH
    ) {
      return `leagueName must be a string of at most ${MAX_LEAGUE_NAME_LENGTH} characters when provided.`;
    }
  }

  if (
    body.seasonYear !== undefined &&
    (typeof body.seasonYear !== "number" || !Number.isInteger(body.seasonYear))
  ) {
    return "seasonYear must be an integer when provided.";
  }

  // platform is optional (older clients won't send it). Used by the shared
  // view to render platform-specific apply instructions; we don't restrict
  // the string set here in case the client adds more platforms before the
  // server is redeployed.
  if (body.platform !== undefined && typeof body.platform !== "string") {
    return "platform must be a string when provided.";
  }

  if (!Array.isArray(body.userIds)) return "userIds must be an array.";
  if (!Array.isArray(body.history)) return "history must be an array.";
  if (!Array.isArray(body.manualDoubles))
    return "manualDoubles must be an array.";

  // rivalryPins is optional (older clients won't send it). Each pin has
  // integer team indices and a week that's either an integer or null
  // ("any week"). Loose validation, matching the doubledPairs treatment.
  if (body.rivalryPins !== undefined) {
    if (!Array.isArray(body.rivalryPins)) {
      return "rivalryPins must be an array when provided.";
    }
    for (const pin of body.rivalryPins) {
      if (!isPlainObject(pin)) return "Each rivalry pin must be an object.";
      if (
        typeof pin.teamA !== "number" ||
        typeof pin.teamB !== "number" ||
        !Number.isInteger(pin.teamA) ||
        !Number.isInteger(pin.teamB)
      ) {
        return "Each rivalry pin must have integer teamA and teamB.";
      }
      if (
        pin.week !== null &&
        !(typeof pin.week === "number" && Number.isInteger(pin.week))
      ) {
        return "rivalryPin.week must be null or an integer.";
      }
    }
  }

  // Weeks arrays render directly in SharedScheduleView, so they get full
  // per-pair validation: every matchup is [int, int] with both indices in
  // [0, teamCount). `field` is interpolated into the error messages.
  const validateWeeks = (weeks: unknown[], field: string): string | null => {
    for (const week of weeks) {
      if (!Array.isArray(week)) {
        return `Each ${field} entry must be an array.`;
      }
      for (const pair of week) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !pair.every(
            (n) =>
              typeof n === "number" &&
              Number.isInteger(n) &&
              n >= 0 &&
              n < teamCount,
          )
        ) {
          return `Each ${field} matchup must be [int, int] with team indices in [0, teamCount).`;
        }
      }
    }
    return null;
  };

  const schedule = body.schedule;
  if (!isPlainObject(schedule)) return "Missing schedule.";
  if (!Array.isArray(schedule.weeks)) return "schedule.weeks must be an array.";
  if (schedule.weeks.length !== format.weekCount) {
    return "schedule.weeks length must match format.weekCount.";
  }
  const weeksError = validateWeeks(schedule.weeks, "schedule.weeks");
  if (weeksError) return weeksError;
  if (!Array.isArray(schedule.doubledPairs)) {
    return "schedule.doubledPairs must be an array.";
  }

  // displayWeeks is optional (older clients won't send it). When present, it
  // mirrors schedule.weeks in shape but with the home/away display order
  // applied — same number of weeks, each week an array of [number, number]
  // tuples.
  if (schedule.displayWeeks !== undefined) {
    if (!Array.isArray(schedule.displayWeeks)) {
      return "schedule.displayWeeks must be an array when provided.";
    }
    if (schedule.displayWeeks.length !== format.weekCount) {
      return "schedule.displayWeeks length must match format.weekCount.";
    }
    const displayWeeksError = validateWeeks(
      schedule.displayWeeks,
      "schedule.displayWeeks",
    );
    if (displayWeeksError) return displayWeeksError;
  }

  if (schedule.rivalryPlacements !== undefined) {
    if (!Array.isArray(schedule.rivalryPlacements)) {
      return "schedule.rivalryPlacements must be an array when provided.";
    }
    for (const p of schedule.rivalryPlacements) {
      if (!isPlainObject(p)) return "Each rivalry placement must be an object.";
      if (
        typeof p.teamA !== "number" ||
        typeof p.teamB !== "number" ||
        !Number.isInteger(p.teamA) ||
        !Number.isInteger(p.teamB) ||
        typeof p.placedWeek !== "number" ||
        !Number.isInteger(p.placedWeek)
      ) {
        return "Each rivalry placement must have integer teamA, teamB, placedWeek.";
      }
      if (
        p.pinnedWeek !== null &&
        !(typeof p.pinnedWeek === "number" && Number.isInteger(p.pinnedWeek))
      ) {
        return "rivalryPlacement.pinnedWeek must be null or an integer.";
      }
    }
  }

  return null;
}
