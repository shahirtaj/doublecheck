// Per-IP rate limiting. When Upstash Redis credentials are present (either
// env naming family - see lib/api/redis.ts), limits are enforced with a
// sliding window in Redis so they hold across serverless instances and cold
// starts. Without credentials - the zero-env local setup the README promises
// for Sleeper/ESPN imports and manual import - we fall back to the in-memory
// token bucket below, which is best-effort per instance. The Redis client is
// constructed lazily and only after the env check, so importing this module
// never throws on an unconfigured machine.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { hasRedisEnv } from "@/lib/api/redis";

type Bucket = { count: number; resetAt: number };

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_WINDOW = 10;
const CLEANUP_THRESHOLD = 1000;

const buckets = new Map<string, Bucket>();

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number };

export type RateLimitOptions = {
  windowMs?: number;
  max?: number;
  // Optional namespace so different routes (e.g. import vs. share) keep
  // separate buckets and don't deplete each other's quota.
  namespace?: string;
};

function checkRateLimitMemory(
  ip: string,
  windowMs: number,
  max: number,
  namespace: string | undefined,
): RateLimitResult {
  const key = namespace ? `${namespace}:${ip}` : ip;
  const now = Date.now();

  if (buckets.size > CLEANUP_THRESHOLD) {
    for (const [k, b] of buckets) {
      if (b.resetAt < now) buckets.delete(k);
    }
  }

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (bucket.count >= max) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count++;
  return { ok: true };
}

// One Ratelimit per (namespace, window, max) combination, cached for the
// lifetime of the instance. Keyed by config so two routes sharing a
// namespace but differing in limits would still get separate limiters.
let redis: Redis | null = null;
const limiters = new Map<string, Ratelimit>();

function getLimiter(
  windowMs: number,
  max: number,
  namespace: string | undefined,
): Ratelimit {
  const key = `${namespace ?? "default"}:${windowMs}:${max}`;
  let limiter = limiters.get(key);
  if (!limiter) {
    redis ??= Redis.fromEnv();
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(max, `${windowMs} ms`),
      prefix: `ratelimit:${namespace ?? "default"}`,
    });
    limiters.set(key, limiter);
  }
  return limiter;
}

export async function checkRateLimit(
  ip: string,
  opts: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const max = opts.max ?? DEFAULT_MAX_PER_WINDOW;

  if (hasRedisEnv()) {
    try {
      const result = await getLimiter(windowMs, max, opts.namespace).limit(ip);
      if (result.success) return { ok: true };
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
      };
    } catch {
      // Redis outage shouldn't take imports or shares down with it - degrade
      // to the per-instance limiter instead of failing the request.
    }
  }

  return checkRateLimitMemory(ip, windowMs, max, opts.namespace);
}

// Trusting the FIRST x-forwarded-for hop is only safe behind a proxy that
// overwrites the header (Vercel does). Behind a proxy that appends instead,
// the first hop is client-controlled - one fresh fake IP per request would
// bypass rate limiting entirely. Re-check this if the app ever moves off
// Vercel or gains another proxy layer.
export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0];
    if (first) return first.trim();
  }
  return req.headers.get("x-real-ip") || "unknown";
}
