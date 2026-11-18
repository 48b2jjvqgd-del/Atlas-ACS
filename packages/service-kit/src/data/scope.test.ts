import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { bindTenantContext, inScope } from './scope.js';

describe('inScope', () => {
  it('fails closed for a pool without a tenant-context schema, before connecting', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://x:y@127.0.0.1:1/x' });
    await expect(inScope(pool, { kind: 'all' }, async () => 1)).rejects.toThrow(
      /no tenant-context schema/,
    );
    await pool.end();
  });

  it('accepts only plain schema identifiers', () => {
    const pool = new pg.Pool();
    expect(() => bindTenantContext(pool, 'issuer; DROP TABLE x')).toThrow(/Invalid schema/);
    expect(bindTenantContext(pool, 'issuer')).toBe(pool);
    void pool.end();
  });
});
