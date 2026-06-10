// Shared lazy Upstash Redis client for the share features. Module-load
// Redis.fromEnv() emits a "[Upstash Redis] ... token is missing" warning on
// every zero-env build (including CI, which has no secrets); constructing on
// first call keeps unconfigured builds silent. hasRedisEnv() mirrors the env
// check in lib/api/rate-limit.ts - the same KV_REST_API_* vars gate both.

import { Redis } from "@upstash/redis";

export function hasRedisEnv(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

let redis: Redis | null = null;

export function getRedis(): Redis {
  redis ??= Redis.fromEnv();
  return redis;
}
