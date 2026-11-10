import { createLogger } from '@atlas/observability';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { createResilientRateLimitStore } from './rate-limit-store.js';

const logger = createLogger({
  service: 'api-gateway',
  version: '0',
  environment: 'test',
  level: 'silent',
});
const incr = (
  store: {
    incr: (
      k: string,
      cb: (e: Error | null, r?: { current: number; ttl: number }) => void,
      w: number,
    ) => void;
  },
  key: string,
) =>
  new Promise<{ current: number; ttl: number }>((resolve, reject) =>
    store.incr(key, (error, result) => (error ? reject(error) : resolve(result!)), 60_000),
  );

describe('resilient rate-limit store', () => {
  it('counts in Valkey when it is available', async () => {
    const counts = new Map<string, number>();
    const redis = {
      eval: async (_script: string, _n: number, key: string) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return [counts.get(key), 59_000];
      },
    } as unknown as Redis;
    const Store = createResilientRateLimitStore(redis, logger);
    const store = new Store().child({ routeInfo: { method: 'GET', url: '/v1/session' } });
    expect((await incr(store, 'ip:1')).current).toBe(1);
    expect((await incr(store, 'ip:1')).current).toBe(2);
    expect([...counts.keys()][0]).toBe('ratelimit:GET/v1/session:ip:1');
  });

  it('keeps limiting with per-instance counters when Valkey fails, instead of failing open', async () => {
    let fallbacks = 0;
    const redis = {
      eval: async () => Promise.reject(new Error('connection refused')),
    } as unknown as Redis;
    const Store = createResilientRateLimitStore(redis, logger, {
      onFallback: () => (fallbacks += 1),
    });
    const store = new Store();
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push((await incr(store, 'ip:2')).current);
    expect(results).toEqual([1, 2, 3]);
    expect(fallbacks).toBe(3);
  });
});
