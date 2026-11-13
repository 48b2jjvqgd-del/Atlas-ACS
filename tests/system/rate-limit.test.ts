import { describe, expect, it } from 'vitest';
import { NORTHSTAR, signedIn } from './client.js';

describe('gateway rate limiting (Valkey-backed)', () => {
  it('limits sensitive configuration changes per session, with Retry-After', async () => {
    const user = await signedIn('admin@northstar.test', { fresh: true });
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      // Stale version: each attempt is refused (409) without changing anything, until limited.
      const response = await user.api('PUT', `/v1/tenants/${NORTHSTAR}/configuration`, {
        expectedVersion: 999_999,
        settings: {},
      });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
        expect(response.body.code).toBe('RATE_LIMITED');
        break;
      }
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.filter((s) => s === 409).length).toBe(20);
    // Reads are governed by a separate, larger budget.
    expect((await user.api('GET', `/v1/tenants/${NORTHSTAR}`)).status).toBe(200);
  });
});
