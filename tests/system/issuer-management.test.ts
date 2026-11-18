import { describe, expect, it } from 'vitest';
import { signedIn, unique } from './client.js';

async function auditFor(
  user: Awaited<ReturnType<typeof signedIn>>,
  tenantId: string,
  action: string,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await user.api(
      'GET',
      `/v1/tenants/${tenantId}/audit/events?action=${action}&limit=50`,
    );
    if (response.body.data.length > 0) return response.body.data;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no ${action} audit record for ${tenantId}`);
}

describe('issuer management', () => {
  it('creates, edits, activates, suspends and reconfigures an issuer — each change audited', async () => {
    const admin = await signedIn('platform.admin@atlas.test');
    const slug = unique('synthetic-issuer');
    const reference = `SYN-${Date.now().toString(36).toUpperCase()}`;
    const created = await admin.api('POST', '/v1/tenants', {
      slug,
      displayName: 'Synthetic Test Bank',
      internalReference: reference,
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect(created.body.data).toMatchObject({
      status: 'onboarding',
      isSynthetic: true,
      internalReference: reference,
    });

    const edited = await admin.api('PATCH', `/v1/tenants/${id}`, {
      displayName: 'Synthetic Test Bank plc',
    });
    expect(edited.body.data.displayName).toBe('Synthetic Test Bank plc');

    expect(
      (
        await admin.api('POST', `/v1/tenants/${id}/status`, {
          status: 'active',
          reason: 'Onboarding complete',
        })
      ).body.data.status,
    ).toBe('active');
    expect(
      (
        await admin.api('POST', `/v1/tenants/${id}/status`, {
          status: 'suspended',
          reason: 'Test suspension',
        })
      ).body.data.status,
    ).toBe('suspended');
    expect(
      (await admin.api('POST', `/v1/tenants/${id}/status`, { status: 'active', reason: 'Resumed' }))
        .body.data.status,
    ).toBe('active');

    const configuration = await admin.api('GET', `/v1/tenants/${id}/configuration`);
    expect(configuration.body.data.version).toBe(1);
    const saved = await admin.api('PUT', `/v1/tenants/${id}/configuration`, {
      expectedVersion: 1,
      settings: {
        ...configuration.body.data.settings,
        supportContactEmail: 'help@synthetic.test',
        schemeParticipation: { visa: true, mastercard: false },
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.version).toBe(2);

    // A change based on a stale version is refused, not silently merged.
    const stale = await admin.api('PUT', `/v1/tenants/${id}/configuration`, {
      expectedVersion: 1,
      settings: configuration.body.data.settings,
    });
    expect(stale.status).toBe(409);

    const [created_] = await auditFor(admin, id, 'issuer.created');
    expect(created_.actor.id).toBe('7c000000-0000-4000-8000-000000000002');
    const [suspended] = await auditFor(admin, id, 'issuer.suspended');
    expect(suspended).toMatchObject({
      reason: 'Test suspension',
      changes: [{ field: 'status', before: 'active', after: 'suspended' }],
    });
    const [reconfigured] = await auditFor(admin, id, 'issuer.configuration.updated');
    expect(reconfigured.changes).toEqual(
      expect.arrayContaining([
        { field: 'settings.supportContactEmail', before: null, after: 'help@synthetic.test' },
        { field: 'settings.schemeParticipation.visa', before: false, after: true },
      ]),
    );
    expect((await auditFor(admin, id, 'issuer.updated'))[0].changes).toEqual([
      { field: 'displayName', before: 'Synthetic Test Bank', after: 'Synthetic Test Bank plc' },
    ]);
  });

  it('rejects invalid data, duplicates and invalid lifecycle transitions', async () => {
    const admin = await signedIn('platform.admin@atlas.test');
    const invalid = await admin.api('POST', '/v1/tenants', {
      slug: 'Not A Slug',
      displayName: '',
      internalReference: 'lower',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('VALIDATION_FAILED');
    expect(invalid.body.issues.map((issue: { path: string }) => issue.path).sort()).toEqual([
      'body.displayName',
      'body.internalReference',
      'body.slug',
    ]);

    const duplicate = await admin.api('POST', '/v1/tenants', {
      slug: 'northstar-bank',
      displayName: 'Copy',
      internalReference: 'COPY-1',
    });
    expect(duplicate.status).toBe(409);

    const onboarding = await admin.api('POST', '/v1/tenants', {
      slug: unique('transition'),
      displayName: 'Transition Test',
      internalReference: `TT-${Date.now().toString(36).toUpperCase()}`,
    });
    const bad = await admin.api('POST', `/v1/tenants/${onboarding.body.data.id}/status`, {
      status: 'suspended',
      reason: 'not yet active',
    });
    expect(bad.status).toBe(409);
    expect(
      (
        await admin.api('POST', `/v1/tenants/${onboarding.body.data.id}/status`, {
          status: 'active',
        })
      ).status,
    ).toBe(400);
  });

  it('assigns an issuer administrator who can then manage only that issuer', async () => {
    const admin = await signedIn('platform.admin@atlas.test');
    const created = await admin.api('POST', '/v1/tenants', {
      slug: unique('assign'),
      displayName: 'Assignment Test',
      internalReference: `AT-${Date.now().toString(36).toUpperCase()}`,
    });
    const id = created.body.data.id as string;
    const email = `${unique('new-admin')}@assignment.test`;
    const invited = await admin.api('POST', `/v1/tenants/${id}/users`, {
      email,
      displayName: 'New Administrator',
      roles: ['issuer-administrator'],
    });
    expect(invited.status).toBe(201);
    expect(invited.body.data).toMatchObject({
      email,
      status: 'invited',
      roles: ['issuer-administrator'],
    });

    const users = await admin.api('GET', `/v1/tenants/${id}/users`);
    expect(users.body.data.map((u: { email: string }) => u.email)).toEqual([email]);

    const changed = await admin.api(
      'PUT',
      `/v1/tenants/${id}/users/${invited.body.data.id}/roles`,
      { roles: ['issuer-administrator', 'compliance-officer'] },
    );
    expect(changed.body.data.roles).toEqual(['compliance-officer', 'issuer-administrator']);
    // Platform roles can never be assigned inside an issuer.
    const escalation = await admin.api(
      'PUT',
      `/v1/tenants/${id}/users/${invited.body.data.id}/roles`,
      { roles: ['platform-super-admin'] },
    );
    expect(escalation.status).toBe(400);

    const [record] = await auditFor(admin, id, 'user.tenant-roles.changed');
    expect(record.changes[0]).toMatchObject({ field: 'roles' });
    await auditFor(admin, id, 'user.invited');

    const removed = await admin.api('DELETE', `/v1/tenants/${id}/users/${invited.body.data.id}`);
    expect(removed.status).toBe(204);
  });

  it('lets an issuer administrator invite users only with issuer roles, and not change their own roles', async () => {
    const issuerAdmin = await signedIn('admin@meridian.test');
    const { body } = await issuerAdmin.session();
    const tenantId = body.data.principal.tenants[0].tenantId as string;
    const self = body.data.principal.userId as string;
    expect(
      (
        await issuerAdmin.api('PUT', `/v1/tenants/${tenantId}/users/${self}/roles`, {
          roles: ['reporting-user'],
        })
      ).status,
    ).toBe(409);
    const escalate = await issuerAdmin.api('POST', `/v1/tenants/${tenantId}/users`, {
      email: `${unique('x')}@meridian.test`,
      displayName: 'X',
      roles: ['platform-administrator'],
    });
    expect(escalate.status).toBe(400);
  });
});
