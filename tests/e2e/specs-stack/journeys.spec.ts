import { expect, test } from '@playwright/test';
import { shot, signInAs, signOut } from './helpers';

const suffix = () => Date.now().toString(36).toUpperCase();

test('platform administrator: registers, activates, configures and suspends an issuer', async ({
  page,
}) => {
  await signInAs(page, 'platform.admin@atlas.test');
  await expect(page.getByRole('heading', { name: 'Platform overview' })).toBeVisible();
  await expect(page.getByTestId('issuer-counts')).not.toContainText('…');
  await expect(page.getByTestId('audit-rows')).toBeVisible();
  await page.screenshot(shot('platform-overview'));

  await page.getByRole('link', { name: 'Issuers' }).first().click();
  await expect(page.getByTestId('issuer-rows')).toContainText('Northstar Bank');
  await expect(page.getByTestId('issuer-rows')).toContainText('Meridian Financial');
  await page.screenshot(shot('issuer-registry'));

  await page.getByRole('button', { name: 'Register issuer' }).click();
  // Invalid data is rejected with field-level messages.
  await page.getByRole('button', { name: 'Register issuer' }).click();
  await expect(page.getByText(/Too small|at least|Invalid/i).first()).toBeVisible();
  const reference = `JRN-${suffix()}`;
  await page.getByLabel('Issuer name').fill(`Journey Synthetic Bank ${reference}`);
  await page.getByLabel('Internal reference').fill(reference);
  await page.screenshot(shot('issuer-create'));
  await page.getByRole('button', { name: 'Register issuer' }).click();
  await expect(
    page.getByRole('heading', { name: `Journey Synthetic Bank ${reference}` }),
  ).toBeVisible();
  await expect(page.getByTestId('toast-success')).toContainText('registered');

  await page.getByRole('button', { name: 'Activate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Onboarding checks complete');
  await dialog.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.getByLabel('Cardholder support email').fill('help@journey.test');
  await page.getByLabel('Visa Secure').check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByTestId('configuration-version')).toHaveText('2');
  await page.screenshot(shot('issuer-configuration'));

  await page.getByRole('button', { name: 'Suspend' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('Journey test suspension');
  await page.getByRole('dialog').getByRole('button', { name: 'Suspend' }).click();
  await expect(page.getByText('Suspended', { exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Audit history' }).click();
  const rows = page.getByTestId('audit-rows');
  // Audit records arrive asynchronously (outbox → RabbitMQ → audit-service), within about a second.
  await expect(async () => {
    await page.getByRole('button', { name: 'Refresh audit records' }).click();
    await expect(rows).toContainText('issuer.suspended', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(rows).toContainText('issuer.configuration.updated');
  await expect(rows).toContainText('issuer.activated');
  await expect(rows).toContainText('issuer.created');
  await rows.getByText('issuer.configuration.updated').click();
  await expect(page.getByText('help@journey.test')).toBeVisible();
  await page.screenshot(shot('issuer-audit-history'));
  await signOut(page);
});

test('platform super admin: users, roles matrix, audit explorer and system health', async ({
  page,
}) => {
  await signInAs(page, 'super.admin@atlas.test');
  await page.goto('/platform/users');
  await expect(page.getByTestId('platform-users')).toContainText('Jordan Ellis');
  await page.screenshot(shot('platform-users'));
  await page.goto('/platform/roles');
  await expect(page.getByTestId('permission-matrix')).toContainText('Customer Support');
  await page.screenshot(shot('roles-and-permissions'));
  await page.goto('/platform/audit');
  await page.getByRole('button', { name: 'Verify platform chain' }).click();
  await expect(page.getByTestId('chain-verification')).toContainText('Chain intact');
  await page.screenshot(shot('audit-explorer'));
  await page.goto('/platform/health');
  await expect(page.getByTestId('service-row-identity-service')).toContainText('Ready');
  await page.screenshot(shot('system-health'));
});

test('issuer administrator: manages own issuer and users, cannot reach platform administration', async ({
  page,
}) => {
  await signInAs(page, 'admin@northstar.test');
  await expect(page).toHaveURL(/\/issuer$/);
  await expect(page.getByTestId('tenant-context')).toBeVisible();
  await expect(page.getByText('Northstar Bank').first()).toBeVisible();
  await page.screenshot(shot('issuer-overview'));

  await page.goto('/platform');
  await expect(page).toHaveURL(/\/issuer$/);

  await page.getByRole('link', { name: 'Users' }).first().click();
  await expect(page.getByTestId('tenant-users')).toContainText('Leo Martins');
  const email = `analyst.${suffix().toLowerCase()}@northstar.test`;
  await page.getByRole('button', { name: 'Invite user' }).click();
  const invite = page.getByRole('dialog');
  await invite.getByLabel('Email').fill(email);
  await invite.getByLabel('Name').fill('Journey Analyst');
  await invite.getByLabel('Fraud Analyst').check();
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByTestId(`user-row-${email}`)).toContainText('Invited');
  await page.screenshot(shot('issuer-users'));

  await page.getByRole('link', { name: 'Profile and configuration' }).click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await page.getByRole('link', { name: 'Audit history' }).click();
  await expect(async () => {
    await page.getByRole('button', { name: 'Refresh audit records' }).click();
    await expect(page.getByTestId('audit-rows')).toContainText('user.invited', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await signOut(page);
});

test('customer support: read-only, restricted navigation, denied changes are refused by the API', async ({
  page,
}) => {
  await signInAs(page, 'support@northstar.test');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('group', { name: 'Issuer' }).getByRole('link')).toHaveText([
    /Overview/,
    /Authentication/,
  ]);
  await expect(nav.getByRole('group', { name: 'Platform' })).toHaveCount(0);
  await page.screenshot(shot('restricted-user'));
  // Even a hand-crafted request is refused by the services.
  const status = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/session')).json();
    const response = await fetch(
      '/api/v1/tenants/1a2b0000-0000-4000-8000-000000000001/configuration',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-atlas-csrf': session.data.csrfToken },
        body: JSON.stringify({ expectedVersion: 1, settings: {} }),
      },
    );
    return response.status;
  });
  expect(status).toBe(403);
  await page.goto('/account');
  await expect(page.getByText('customer-support')).toBeVisible();
  await page.screenshot(shot('account-security'));
});

test('tablet layout for an issuer administrator @tablet', async ({ page }) => {
  await signInAs(page, 'admin@meridian.test');
  await expect(page.getByRole('heading', { name: 'Issuer overview' })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('dialog', { name: 'Navigation' })
    .getByRole('link', { name: 'Users' })
    .click();
  await expect(page.getByTestId('tenant-users')).toContainText('Aisha Bello');
  await page.screenshot(shot('tablet-issuer-users'));
});
