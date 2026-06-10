// Shared lazy Upstash Redis client for the share features. Module-load
// Redis.fromEnv() emits a "[Upstash Redis] ... token is missing" warning on
// every zero-env build (including CI, which has no secrets); constructing on
// first call keeps unconfigured builds silent. hasRedisEnv() is the single
// gate for "is Redis configured?" - rate limiting imports it too.

import { Redis } from "@upstash/redis";

// Redis.fromEnv() accepts both env naming families: KV_REST_API_* (what
// .env.example documents and production uses) and UPSTASH_REDIS_REST_* (what
// Upstash's own docs say to set). Accept either COMPLETE pair - a mixed or
// partial set still can't construct a working client.
export function hasRedisEnv(): boolean {
  return Boolean(
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ||
    (process.env.UPSTASH_REDIS_REST_URL &&
      process.env.UPSTASH_REDIS_REST_TOKEN),
  );
}

let redis: Redis | null = null;

export function getRedis(): Redis {
  redis ??= Redis.fromEnv();
  return redis;
}
