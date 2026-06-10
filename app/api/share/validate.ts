// Validation for the share POST payload, in a sibling module so it can be
// unit-tested directly (Next.js route files may only export route handlers).

export const MAX_TEAM_COUNT = 32;
export const MAX_TEAM_NAME_LENGTH = 64;
export const MAX_LEAGUE_NAME_LENGTH = 128;
export const MAX_USER_ID_LENGTH = 128;
export const MAX_SEASON_LABEL_LENGTH = 16;
export const MAX_DOUBLE_KEY_LENGTH = 256;

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

  // Index pair key as the client builds them with pairKey(): "i-j" with
  // i < j, both inside the roster. Restore indexes oldToNew[i]! with these,
  // so an out-of-range index would smuggle undefined into the importer's
  // state - range-check them like the weeks arrays.
  const isIndexPairKey = (v: unknown): boolean => {
    if (typeof v !== "string" || !/^\d{1,3}-\d{1,3}$/.test(v)) return false;
    const dash = v.indexOf("-");
    const i = Number(v.slice(0, dash));
    const j = Number(v.slice(dash + 1));
    return i < j && j < teamCount;
  };

  if (!Array.isArray(body.userIds)) return "userIds must be an array.";
  if (body.userIds.length !== teamCount) {
    return "userIds length must match format.teamCount.";
  }
  if (
    !body.userIds.every(
      (u) =>
        u === null || (typeof u === "string" && u.length <= MAX_USER_ID_LENGTH),
    )
  ) {
    return `userIds must be null or strings of at most ${MAX_USER_ID_LENGTH} characters.`;
  }

  // History rows feed the importer's avoidance window on restore, so their
  // shape is validated in full. format may be absent on rows from older
  // payloads being re-shared; the client treats those as index format, so
  // they get the index-key check.
  if (!Array.isArray(body.history)) return "history must be an array.";
  const maxDoublesPerSeason = (teamCount * (teamCount - 1)) / 2;
  for (const row of body.history) {
    if (!isPlainObject(row)) return "Each history row must be an object.";
    if (
      typeof row.season !== "string" ||
      row.season.length > MAX_SEASON_LABEL_LENGTH
    ) {
      return `history.season must be a string of at most ${MAX_SEASON_LABEL_LENGTH} characters.`;
    }
    if (
      row.format !== undefined &&
      row.format !== "userid" &&
      row.format !== "index"
    ) {
      return 'history.format must be "userid" or "index" when provided.';
    }
    if (!Array.isArray(row.doubles)) {
      return "history.doubles must be an array.";
    }
    if (row.doubles.length > maxDoublesPerSeason) {
      return "history.doubles has more entries than the roster has pairs.";
    }
    if (row.format === "userid") {
      if (
        !row.doubles.every(
          (k) =>
            typeof k === "string" &&
            k.length <= MAX_DOUBLE_KEY_LENGTH &&
            k.includes(":"),
        )
      ) {
        return 'Each userid-format double must be an "idA:idB" string.';
      }
    } else if (!row.doubles.every(isIndexPairKey)) {
      return 'Each index-format double must be "i-j" with i < j < teamCount.';
    }
  }

  if (!Array.isArray(body.manualDoubles))
    return "manualDoubles must be an array.";
  if (!body.manualDoubles.every(isIndexPairKey)) {
    return 'Each manual double must be "i-j" with i < j < teamCount.';
  }

  // rivalryPins is optional (older clients won't send it). Each pin has
  // distinct in-range team indices and a week that's either in range or
  // null ("any week") - restore remaps the indices through oldToNew, so
  // they get the same bounds treatment as the weeks arrays.
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
        pin.teamA < 0 ||
        pin.teamA >= teamCount ||
        pin.teamB < 0 ||
        pin.teamB >= teamCount ||
        pin.teamA === pin.teamB
      ) {
        return "Rivalry pin team indices must be distinct and in [0, teamCount).";
      }
      if (
        pin.week !== null &&
        !(
          typeof pin.week === "number" &&
          Number.isInteger(pin.week) &&
          pin.week >= 1 &&
          pin.week <= format.weekCount
        )
      ) {
        return "rivalryPin.week must be null or an integer between 1 and format.weekCount.";
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
  if (!schedule.doubledPairs.every(isIndexPairKey)) {
    return 'Each doubled pair must be "i-j" with i < j < teamCount.';
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
      if (p.placedWeek < 1 || p.placedWeek > format.weekCount) {
        return "rivalryPlacement.placedWeek must be between 1 and format.weekCount.";
      }
      if (
        p.pinnedWeek !== null &&
        !(
          typeof p.pinnedWeek === "number" &&
          Number.isInteger(p.pinnedWeek) &&
          p.pinnedWeek >= 1 &&
          p.pinnedWeek <= format.weekCount
        )
      ) {
        return "rivalryPlacement.pinnedWeek must be null or an integer between 1 and format.weekCount.";
      }
    }
  }

  return null;
}
