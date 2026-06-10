// GET the saved share payload for a slug. Used by the client-side
// "Restore from share link" flow on the home page (the /s/[slug] page
// reads the payload server-side, not through this route). 404s when the
// slug is missing or the entry has expired.

import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { checkRateLimit, getClientIp } from "@/lib/api/rate-limit";

const redis = Redis.fromEnv();

const RESTORE_WINDOW_MS = 60 * 60 * 1000;
const RESTORE_MAX_PER_WINDOW = 30;
const SLUG_REGEX = /^[a-z0-9]{8}$/;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const rl = await checkRateLimit(getClientIp(req), {
    windowMs: RESTORE_WINDOW_MS,
    max: RESTORE_MAX_PER_WINDOW,
    namespace: "share-restore",
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Retry in ${rl.retryAfter}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const { slug } = await params;
  if (!SLUG_REGEX.test(slug)) {
    return NextResponse.json({ error: "Invalid share link." }, { status: 400 });
  }

  let data: unknown;
  try {
    data = await redis.get(`share:${slug}`);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || "Failed to read share storage." },
      { status: 502 },
    );
  }
  if (data == null) {
    return NextResponse.json(
      { error: "Share link not found or expired." },
      { status: 404 },
    );
  }
  return NextResponse.json(data);
}
