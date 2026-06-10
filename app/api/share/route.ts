// POST a serialized league state and get back a short slug URL. The slug IS
// the access token: anyone with the URL can read the schedule. Stored in
// Upstash Redis with a 365-day TTL so storage stays bounded; users recreate
// the link via the same flow if it expires.

import { NextResponse } from "next/server";
import { getRedis, hasRedisEnv } from "@/lib/api/redis";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";
import { validatePayload } from "./validate";

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

export async function POST(req: Request) {
  // The zero-env local setup the README promises has no share storage - say
  // so deliberately instead of letting an unconfigured client fail opaquely.
  if (!hasRedisEnv()) {
    return NextResponse.json(
      { error: "Sharing requires Upstash Redis configuration." },
      { status: 503 },
    );
  }

  const rl = await checkRateLimit(getClientIp(req), {
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
      const result = await getRedis().set(`share:${candidate}`, body, {
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
