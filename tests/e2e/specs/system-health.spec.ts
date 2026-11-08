import { expect, test } from '@playwright/test';
import { gatewayDown, platformServicesBody, stubGateway } from './fixtures';

test('renders live service status reported by the gateway', async ({ page }) => {
  await stubGateway(page);
  await page.goto('/platform/health');

  await expect(page.getByText('2 of 4 ready')).toBeVisible();
  await expect(page.getByTestId('service-row-acs-core')).toContainText('Ready');
  await expect(page.getByTestId('service-row-acs-core')).toContainText('rabbitmq');
  await expect(page.getByTestId('service-row-fraud-engine')).toContainText('Not ready');
  await expect(page.getByTestId('service-row-visa-adapter')).toContainText('Unreachable');
});

test('sends a correlation ID with every API request', async ({ page }) => {
  await stubGateway(page);
  const request = page.waitForRequest('**/api/v1/platform/services');
  await page.goto('/platform/health');
  expect((await request).headers()['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
});

test('explains when the gateway cannot be reached', async ({ page }) => {
  await gatewayDown(page);
  await page.goto('/platform/health');
  await expect(page.getByRole('alert')).toContainText('The API gateway could not be reached.');
});

test('refuses to render a response that violates the published contract', async ({ page }) => {
  const invalid = structuredClone(platformServicesBody) as {
    data: { services: { status: string }[] };
  };
  invalid.data.services[0]!.status = 'mostly-fine';
  await stubGateway(page, invalid);
  await page.goto('/platform/health');
  await expect(page.getByRole('alert')).toContainText('did not match the published contract');
});

test('surfaces gateway problem details, e.g. rate limiting', async ({ page }) => {
  await stubGateway(
    page,
    {
      type: 'urn:atlas:problem:rate-limited',
      title: 'Too many requests',
      status: 429,
      detail: 'Retry after 42s',
      code: 'RATE_LIMITED',
      correlationId: '7c2b6a8e-1f0d-4b51-9d1e-3a2f4c5b6d7e',
    },
    429,
  );
  await page.goto('/platform/health');
  await expect(page.getByRole('alert')).toContainText('Retry after 42s');
});
