// Per-IP token bucket. Lives in module scope so it persists across requests
// inside a warm serverless container; cold starts reset it, which is fine
// for a 60s window. Fits Phase 3's "no external dependencies" constraint.

type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const CLEANUP_THRESHOLD = 1000;

const buckets = new Map<string, Bucket>();

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number };

export function checkRateLimit(ip: string): RateLimitResult {
  const now = Date.now();

  if (buckets.size > CLEANUP_THRESHOLD) {
    for (const [key, b] of buckets) {
      if (b.resetAt < now) buckets.delete(key);
    }
  }

  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true };
  }
  if (bucket.count >= MAX_PER_WINDOW) {
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
