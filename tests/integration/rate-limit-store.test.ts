import { randomBytes } from 'node:crypto';
import { createLogger } from '@atlas/observability';
import { createResilientRateLimitStore } from '@atlas/api-gateway/rate-limit-store';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { infrastructure } from './env.js';

const logger = createLogger({
  service: 'integration',
  version: '0',
  environment: 'test',
  level: 'silent',
});
const redis = new Redis(infrastructure.valkeyUrl, {
  keyPrefix: `atlas:api-gateway:it-${randomBytes(3).toString('hex')}:`,
});
afterAll(() => redis.quit());

type Store = {
  incr: (
    key: string,
    cb: (e: Error | null, r?: { current: number; ttl: number }) => void,
    window: number,
  ) => void;
};
const incr = (store: Store, key: string) =>
  new Promise<number>((resolve, reject) =>
    store.incr(key, (error, result) => (error ? reject(error) : resolve(result!.current)), 60_000),
  );

describe('Valkey-backed rate limiting', () => {
  it('shares counters between gateway instances, so limits hold across a scaled-out edge', async () => {
    const A = createResilientRateLimitStore(redis, logger);
    const B = createResilientRateLimitStore(redis, logger);
    const first = new A();
    const second = new B();
    expect(await incr(first, 'client-1')).toBe(1);
    expect(await incr(second, 'client-1')).toBe(2);
    expect(await incr(first, 'client-1')).toBe(3);
    expect(await redis.pttl('ratelimit:client-1')).toBeGreaterThan(50_000);
  });
});
