// POST a serialized league state and get back a short slug URL. The slug IS
// the access token: anyone with the URL can read the schedule. Stored in
// Upstash Redis with a 365-day TTL so storage stays bounded; users recreate
// the link via the same flow if it expires.

import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";

const redis = Redis.fromEnv();

const SLUG_LENGTH = 8;
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TTL_SECONDS = 60 * 60 * 24 * 365;
const MAX_SLUG_ATTEMPTS = 5;
const SHARE_WINDOW_MS = 60 * 60 * 1000;
const SHARE_MAX_PER_WINDOW = 15;

function generateSlug(): string {
  const bytes = new Uint8Array(SLUG_LENGTH);
  crypto.getRandomValues(bytes);
  let slug = "";
  for (let i = 0; i < SLUG_LENGTH; i++) {
    slug += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  }
  return slug;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function validatePayload(body: unknown): string | null {
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

  if (!Array.isArray(body.teams)) return "teams must be an array.";
  if (body.teams.length !== format.teamCount) {
    return "teams length must match format.teamCount.";
  }
  if (!body.teams.every((t) => typeof t === "string")) {
    return "teams must be strings.";
  }

  if (body.leagueName !== undefined && typeof body.leagueName !== "string") {
    return "leagueName must be a string when provided.";
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

  const schedule = body.schedule;
  if (!isPlainObject(schedule)) return "Missing schedule.";
  if (!Array.isArray(schedule.weeks)) return "schedule.weeks must be an array.";
  if (schedule.weeks.length !== format.weekCount) {
    return "schedule.weeks length must match format.weekCount.";
  }
  if (!Array.isArray(schedule.doubledPairs)) {
    return "schedule.doubledPairs must be an array.";
  }

  // displayWeeks is optional (older clients won't send it). When present, it
  // mirrors schedule.weeks in shape but with the home/away display order
  // applied — same number of weeks, each week an array of [number, number]
  // tuples. Loose validation: shape only, no per-pair sanity check.
  if (schedule.displayWeeks !== undefined) {
    if (!Array.isArray(schedule.displayWeeks)) {
      return "schedule.displayWeeks must be an array when provided.";
    }
    if (schedule.displayWeeks.length !== format.weekCount) {
      return "schedule.displayWeeks length must match format.weekCount.";
    }
    for (const week of schedule.displayWeeks) {
      if (!Array.isArray(week)) {
        return "Each schedule.displayWeeks entry must be an array.";
      }
      for (const pair of week) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !pair.every((n) => typeof n === "number" && Number.isInteger(n))
        ) {
          return "Each schedule.displayWeeks matchup must be [int, int].";
        }
      }
    }
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

export async function POST(req: Request) {
  const rl = checkRateLimit(getClientIp(req), {
    windowMs: SHARE_WINDOW_MS,
    max: SHARE_MAX_PER_WINDOW,
    namespace: "share",
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Retry in ${rl.retryAfter}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const payloadSize = JSON.stringify(body).length;
  if (payloadSize > 512_000) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const validationError = validatePayload(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  // Generate a slug; SETNX retries on the (extremely unlikely) collision.
  let slug: string | null = null;
  for (let i = 0; i < MAX_SLUG_ATTEMPTS; i++) {
    const candidate = generateSlug();
    try {
      const result = await redis.set(`share:${candidate}`, body, {
        nx: true,
        ex: TTL_SECONDS,
      });
      if (result === "OK") {
        slug = candidate;
        break;
      }
    } catch (e) {
      return NextResponse.json(
        { error: (e as Error).message || "Failed to write to share storage." },
        { status: 502 },
      );
    }
  }
  if (!slug) {
    return NextResponse.json(
      { error: "Could not allocate a unique share slug." },
      { status: 500 },
    );
  }

  return NextResponse.json({ url: `/s/${slug}` });
}
