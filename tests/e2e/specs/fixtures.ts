import type { Page } from '@playwright/test';

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
  meta: { correlationId: '7c2b6a8e-1f0d-4b51-9d1e-3a2f4c5b6d7e', apiVersion: 'v1' },
};

export async function stubGateway(page: Page, body: unknown = platformServicesBody, status = 200) {
  await page.route('**/api/v1/platform/services', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

export async function gatewayDown(page: Page) {
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
}
