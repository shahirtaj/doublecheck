// Per-IP token bucket. Lives in module scope so it persists across requests
// inside a warm serverless container; cold starts reset it, which is fine
// for a 60s window. Fits Phase 3's "no external dependencies" constraint.

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

export function checkRateLimit(ip: string, opts: RateLimitOptions = {}): RateLimitResult {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const max = opts.max ?? DEFAULT_MAX_PER_WINDOW;
  const key = opts.namespace ? `${opts.namespace}:${ip}` : ip;
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

export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0];
    if (first) return first.trim();
  }
  return req.headers.get("x-real-ip") || "unknown";
}
