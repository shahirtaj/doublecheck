// POST a serialized league state and get back a short slug URL. The slug IS
// the access token: anyone with the URL can read the schedule. Stored in
// Vercel KV with a 365-day TTL so storage stays bounded; users recreate the
// link via the same flow if it expires.

import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";

const SLUG_LENGTH = 8;
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TTL_SECONDS = 60 * 60 * 24 * 365;
const MAX_SLUG_ATTEMPTS = 5;
const SHARE_WINDOW_MS = 60 * 60 * 1000;
const SHARE_MAX_PER_WINDOW = 5;

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

  if (!Array.isArray(body.userIds)) return "userIds must be an array.";
  if (!Array.isArray(body.history)) return "history must be an array.";
  if (!Array.isArray(body.manualDoubles)) return "manualDoubles must be an array.";

  const schedule = body.schedule;
  if (!isPlainObject(schedule)) return "Missing schedule.";
  if (!Array.isArray(schedule.weeks)) return "schedule.weeks must be an array.";
  if (schedule.weeks.length !== format.weekCount) {
    return "schedule.weeks length must match format.weekCount.";
  }
  if (!Array.isArray(schedule.doubledPairs)) {
    return "schedule.doubledPairs must be an array.";
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

  const validationError = validatePayload(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  // Generate a slug; SETNX retries on the (extremely unlikely) collision.
  let slug: string | null = null;
  for (let i = 0; i < MAX_SLUG_ATTEMPTS; i++) {
    const candidate = generateSlug();
    try {
      const result = await kv.set(`share:${candidate}`, body, {
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
