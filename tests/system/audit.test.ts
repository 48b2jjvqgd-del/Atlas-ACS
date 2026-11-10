import { describe, expect, it } from 'vitest';
import { MERIDIAN, PORTAL, signedIn } from './client.js';

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('audit trail', () => {
  it('records sign-in and sign-out', async () => {
    const user = await signedIn('operations@northstar.test', { fresh: true });
    const userId = (await user.session()).body.data.principal.userId as string;
    await user.api('POST', '/v1/auth/logout');
    const auditor = await signedIn('super.admin@atlas.test');
    const actions = await waitFor(async () => {
      const records = (
        await auditor.api('GET', `/v1/audit/events?actorId=${userId}&action=auth.&limit=20`)
      ).body.data as { action: string }[];
      const found = records.map((r) => r.action);
      return found.includes('auth.signed-in') && found.includes('auth.signed-out')
        ? found
        : undefined;
    });
    expect(actions).toEqual(expect.arrayContaining(['auth.signed-in', 'auth.signed-out']));
  });

  it('records access-denied events, cross-tenant attempts on the platform chain', async () => {
    const intruder = await signedIn('support@northstar.test');
    const userId = (await intruder.session()).body.data.principal.userId as string;
    expect((await intruder.api('GET', `/v1/tenants/${MERIDIAN}/configuration`)).status).toBe(404);
    const auditor = await signedIn('super.admin@atlas.test');
    const record = await waitFor(async () => {
      const records = (
        await auditor.api('GET', `/v1/audit/events?actorId=${userId}&action=access.denied&limit=20`)
      ).body.data as {
        tenantId: string | null;
        metadata: Record<string, unknown>;
      }[];
      return records.find((r) => r.metadata.targetTenantId === MERIDIAN);
    });
    expect(record.tenantId).toBeNull(); // not disclosed to Meridian's own audit readers
    expect(record.metadata).toMatchObject({
      reason: 'tenant-not-accessible',
      permission: 'issuer.configuration.read',
    });
  });

  it('stores no tokens, passwords or session identifiers in audit records', async () => {
    const auditor = await signedIn('super.admin@atlas.test');
    const records = (await auditor.api('GET', '/v1/audit/events?limit=200')).body.data;
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    expect(text).not.toContain(process.env.ATLAS_DEMO_PASSWORD!);
    expect(text).not.toMatch(/atlas_session/);
  });

  it('offers no way to change or delete audit records through the API', async () => {
    const auditor = await signedIn('super.admin@atlas.test');
    const [record] = (await auditor.api('GET', '/v1/audit/events?limit=1')).body.data;
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const response = await auditor.api(
        method,
        `/v1/audit/events/${record.id}`,
        method === 'DELETE' ? undefined : { action: 'tampered' },
      );
      expect(response.status, method).toBeGreaterThanOrEqual(404);
      expect(response.status).toBeLessThan(500);
    }
    expect((await auditor.api('GET', `/v1/audit/events/${record.id}`)).body.data.hash).toBe(
      record.hash,
    );
  });

  it('verifies the hash chains', async () => {
    const auditor = await signedIn('tech.admin@atlas.test');
    const platform = await auditor.api('GET', '/v1/audit/chains/platform/verify');
    expect(platform.body.data).toMatchObject({ valid: true, firstInvalidSequence: null });
    expect(platform.body.data.records).toBeGreaterThan(0);
    const issuerAdmin = await signedIn('admin@northstar.test');
    expect((await issuerAdmin.api('GET', '/v1/audit/chains/platform/verify')).status).toBe(403);
    void PORTAL;
  });
});
