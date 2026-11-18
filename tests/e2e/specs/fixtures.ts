import { systemRoles, type Permission, type SystemRoleKey } from '@atlas/contracts';
import type { Page } from '@playwright/test';

/**
 * Deterministic UI tests: API calls are intercepted with contract-shaped responses, so these specs
 * exercise the portal's behaviour (permission-driven navigation, states, forms) without services.
 * Behaviour against the real stack is covered by specs-stack/.
 */
export const NORTHSTAR = '1a2b0000-0000-4000-8000-000000000001';
export const MERIDIAN = '1a2b0000-0000-4000-8000-000000000002';
const meta = { correlationId: '7c2b6a8e-1f0d-4b51-9d1e-3a2f4c5b6d7e', apiVersion: 'v1' };

const permissionsOf = (roles: SystemRoleKey[]): Permission[] =>
  [
    ...new Set(roles.flatMap((role) => systemRoles[role].permissions as readonly Permission[])),
  ].sort();

export function persona(
  kind: 'platform-admin' | 'northstar-admin' | 'northstar-support' | 'northstar-reporting',
) {
  const base = {
    subject: '5ab00000-0000-4000-8000-000000000099',
    email: 'person@example.test',
    status: 'active' as const,
    platformRoles: [] as string[],
    platformPermissions: [] as Permission[],
    tenants: [] as { tenantId: string; roles: string[]; permissions: Permission[] }[],
  };
  switch (kind) {
    case 'platform-admin':
      return {
        ...base,
        userId: '7c000000-0000-4000-8000-000000000001',
        displayName: 'Avery Quinn',
        platformRoles: ['platform-super-admin'],
        platformPermissions: permissionsOf(['platform-super-admin']),
      };
    case 'northstar-admin':
      return {
        ...base,
        userId: '7c000000-0000-4000-8000-000000000011',
        displayName: 'Priya Raman',
        tenants: [
          {
            tenantId: NORTHSTAR,
            roles: ['issuer-administrator'],
            permissions: permissionsOf(['issuer-administrator']),
          },
        ],
      };
    case 'northstar-support':
      return {
        ...base,
        userId: '7c000000-0000-4000-8000-000000000016',
        displayName: 'Leo Martins',
        tenants: [
          {
            tenantId: NORTHSTAR,
            roles: ['customer-support'],
            permissions: permissionsOf(['customer-support']),
          },
        ],
      };
    case 'northstar-reporting':
      return {
        ...base,
        userId: '7c000000-0000-4000-8000-000000000017',
        displayName: 'Grace Kim',
        tenants: [
          {
            tenantId: NORTHSTAR,
            roles: ['reporting-user'],
            permissions: permissionsOf(['reporting-user']),
          },
        ],
      };
  }
}

export const tenant = (id: string, name: string, status = 'active') => ({
  id,
  slug: name.toLowerCase().replaceAll(' ', '-'),
  displayName: name,
  internalReference: `${name.slice(0, 3).toUpperCase()}-0001`,
  status,
  isSynthetic: true,
  createdAt: '2026-11-08T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
});

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** Signs a persona in (stubbed session) and stubs the common reads. */
export async function signIn(
  page: Page,
  kind: Parameters<typeof persona>[0],
  options: { mfa?: boolean } = {},
) {
  const principal = persona(kind);
  // Catch-all first (later routes take precedence): unstubbed calls never reach a real gateway.
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'urn:atlas:problem:service-unavailable',
        title: 'Service unavailable',
        status: 503,
        detail: 'Not stubbed in this test',
        code: 'SERVICE_UNAVAILABLE',
        correlationId: meta.correlationId,
      }),
    }),
  );
  const tenants =
    kind === 'platform-admin'
      ? [tenant(NORTHSTAR, 'Northstar Bank'), tenant(MERIDIAN, 'Meridian Financial', 'suspended')]
      : [tenant(NORTHSTAR, 'Northstar Bank')];
  await page.route('**/api/v1/session', (route) =>
    route.fulfill(
      json({
        data: {
          principal,
          csrfToken: 'c'.repeat(43),
          authenticatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
          idleExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
          mfa: options.mfa ?? kind === 'platform-admin',
          accountUrl: 'http://localhost:8180/realms/atlas/account',
        },
        meta,
      }),
    ),
  );
  await page.route('**/api/v1/tenants?*', (route) =>
    route.fulfill(
      json({ data: tenants, meta: { ...meta, total: tenants.length, limit: 200, offset: 0 } }),
    ),
  );
  await page.route(`**/api/v1/tenants/${NORTHSTAR}`, (route) =>
    route.fulfill(json({ data: tenants[0], meta })),
  );
  await page.route(/\/api\/v1\/(tenants\/[^/]+\/)?audit\/events/, (route) =>
    route.fulfill(json({ data: [], meta: { ...meta, nextBefore: null } })),
  );
  await page.route('**/api/v1/identity/roles', (route) => route.fulfill(json({ data: [], meta })));
  return principal;
}

export async function signedOut(page: Page, detail = 'Sign in to continue') {
  await page.route('**/api/v1/session', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'urn:atlas:problem:unauthenticated',
        title: 'Authentication required',
        status: 401,
        detail,
        code: 'UNAUTHENTICATED',
        correlationId: meta.correlationId,
      }),
    }),
  );
}

export const platformServicesBody = {
  data: {
    checkedAt: '2026-11-06T12:00:00.000Z',
    services: [
      { service: 'api-gateway', status: 'ready', version: '0.1.0', latencyMs: 1.2, checks: [] },
      {
        service: 'acs-core',
        status: 'ready',
        version: '0.1.0',
        latencyMs: 4.8,
        checks: [
          { name: 'postgres', status: 'up', latencyMs: 2.1 },
          { name: 'valkey', status: 'up', latencyMs: 0.9 },
          { name: 'rabbitmq', status: 'up', latencyMs: 3.3 },
        ],
      },
      {
        service: 'fraud-engine',
        status: 'not_ready',
        version: '0.1.0',
        latencyMs: 2001.5,
        checks: [{ name: 'postgres', status: 'down', latencyMs: 2000, error: 'timeout' }],
      },
      {
        service: 'visa-adapter',
        status: 'unreachable',
        version: null,
        latencyMs: null,
        checks: [],
      },
    ],
  },
  meta,
};

export async function stubGateway(page: Page, body: unknown = platformServicesBody, status = 200) {
  await page.route('**/api/v1/platform/services', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

export async function gatewayDown(page: Page) {
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
}
