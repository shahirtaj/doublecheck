// POST a serialized league state and get back a short slug URL. The slug IS
// the access token: anyone with the URL can read the schedule. Stored in
// Upstash Redis with a 365-day TTL so storage stays bounded; users recreate
// the link via the same flow if it expires.

import { NextResponse } from "next/server";
import { getRedis, hasRedisEnv } from "@/lib/api/redis";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";
import { buildStoredPayload, validatePayload } from "./validate";

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

  // Size-check the raw text before parsing so an oversized body is rejected
  // without paying its parse cost. Vercel's platform body cap is the outer
  // bound; this is the app-level one.
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 512_000) {
      return NextResponse.json(
        { error: "Payload too large." },
        { status: 413 },
      );
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const validationError = validatePayload(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  // Store only the known fields, rebuilt field-by-field down to the nested
  // objects (see buildStoredPayload). Persisting the raw body - or any
  // nested object wholesale - would host arbitrary unvalidated extra keys
  // under our domain (a free JSON dead-drop, re-served verbatim by the GET
  // route) - this is an open endpoint.
  const stored = buildStoredPayload(body as Record<string, unknown>);

  // Generate a slug; SETNX retries on the (extremely unlikely) collision.
  let slug: string | null = null;
  for (let i = 0; i < MAX_SLUG_ATTEMPTS; i++) {
    const candidate = generateSlug();
    try {
      const result = await getRedis().set(`share:${candidate}`, stored, {
        nx: true,
        ex: TTL_SECONDS,
      });
      if (result === "OK") {
        slug = candidate;
        break;
      }
    } catch (e) {
      // Raw client errors can expose backend internals (Upstash auth/URL
      // messages); log them and answer generically.
      console.error("[/api/share] Redis write failed:", e);
      return NextResponse.json(
        { error: "Could not write to share storage." },
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
