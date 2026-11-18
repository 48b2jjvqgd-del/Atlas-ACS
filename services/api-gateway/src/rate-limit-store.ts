import type { Logger } from '@atlas/observability';
import type { Redis } from 'ioredis';

/**
 * Rate-limit counter store for @fastify/rate-limit: shared counters in Valkey, so limits hold
 * across every gateway instance, with a safe fallback.
 *
 * If Valkey is unavailable the store does NOT fail open (no limit) and does NOT fail closed (reject
 * everyone): it counts in process memory instead, so each instance still enforces the limit on its
 * own traffic. Recovery is automatic on the next successful Valkey call.
 *
 * Fixed window per key: INCR, set expiry on first hit, report remaining TTL.
 */
const script = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {current, ttl}
`;

type Callback = (error: Error | null, result?: { current: number; ttl: number }) => void;

/** The plugin passes route parameters with routeInfo at runtime; its typings declare route options. */
interface RouteInfo {
  routeInfo?: { method?: string | string[]; url?: string };
  method?: string | string[];
  url?: string;
}

export interface RateLimitStoreHooks {
  onFallback?: () => void;
}

export function createResilientRateLimitStore(
  redis: Redis,
  logger: Logger,
  hooks: RateLimitStoreHooks = {},
) {
  const local = new Map<string, { count: number; resetAt: number }>();
  let degradedSince = 0;

  const localIncr = (key: string, windowMs: number) => {
    const now = Date.now();
    let entry = local.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      if (local.size > 10_000) local.delete(local.keys().next().value as string);
    }
    entry.count += 1;
    local.set(key, entry);
    return { current: entry.count, ttl: entry.resetAt - now };
  };

  return class ResilientStore {
    readonly prefix: string;

    constructor(_globalParams?: unknown, prefix = 'ratelimit:') {
      this.prefix = prefix;
    }

    incr(key: string, callback: Callback, timeWindow: number): void {
      const fullKey = `${this.prefix}${key}`;
      redis
        .eval(script, 1, fullKey, String(timeWindow))
        .then((result) => {
          const [current, ttl] = result as [number, number];
          if (degradedSince) {
            logger.info(
              { degradedForMs: Date.now() - degradedSince },
              'rate limiting restored to Valkey',
            );
            degradedSince = 0;
          }
          callback(null, { current, ttl });
        })
        .catch(() => {
          if (!degradedSince) {
            degradedSince = Date.now();
            logger.warn('Valkey unavailable: rate limiting degraded to per-instance counters');
          }
          hooks.onFallback?.();
          callback(null, localIncr(fullKey, timeWindow));
        });
    }

    child(options: object): ResilientStore {
      const routeOptions = options as RouteInfo;
      const method = routeOptions.routeInfo?.method ?? routeOptions.method ?? '';
      const url = routeOptions.routeInfo?.url ?? routeOptions.url ?? '';
      const route = `${Array.isArray(method) ? method.join('|') : method}${url}`;
      return new ResilientStore(undefined, `${this.prefix}${route}:`);
    }
  };
}
