import { expect, test } from '@playwright/test';
import { gatewayDown } from './fixtures';

test.beforeEach(async ({ page }) => {
  await gatewayDown(page);
});

test('shows ATLAS branding, environment indicator and authentication status', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('ATLAS ACS');
  await expect(page.getByRole('heading', { name: 'Welcome to ATLAS' })).toBeVisible();

  const environment = page.getByTestId('environment-indicator');
  await expect(environment).toContainText('DEVELOPMENT');
  await expect(environment).toContainText('SIMULATION');

  const auth = page.getByTestId('auth-status');
  await expect(auth.getByRole('button', { name: 'Sign in' })).toBeDisabled();
});

test('offers platform administration and issuer workspace entry points', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('workspace-entry-issuer').click();
  await expect(page).toHaveURL(/\/issuer$/);
  await expect(page.getByRole('heading', { name: 'Issuer overview' })).toBeVisible();
  await expect(page.getByTestId('tenant-context')).toHaveText('No issuer selected.');

  await page.goto('/');
  await page.getByTestId('workspace-entry-platform').click();
  await expect(page.getByRole('heading', { name: 'Platform overview' })).toBeVisible();
});

test('marks every unbuilt area as a placeholder with its planned stage', async ({
  page,
  viewport,
}) => {
  test.skip((viewport?.width ?? 0) < 1024, 'sidebar navigation is covered on desktop');
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });

  const expectations: [string, string, string][] = [
    ['Platform', 'Issuers', 'Stage 1A'],
    ['Platform', 'Integrations', 'Stage 1B'],
    ['Platform', 'Audit', 'Stage 5'],
    ['Issuer', 'Fraud rules', 'Stage 2'],
    ['Issuer', 'Challenges', 'Stage 3'],
    ['Issuer', 'Compliance', 'Stage 4'],
  ];
  for (const [group, label, stage] of expectations) {
    await navigation
      .getByRole('group', { name: group })
      .getByRole('link', { name: new RegExp(`^${label}`) })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
    await expect(page.getByRole('note', { name: 'Placeholder' })).toContainText(
      `Placeholder · Planned for ${stage}`,
    );
  }
});

test('lists every required navigation entry', async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 1024, 'sidebar is collapsed into a drawer on tablet');
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  const platform = navigation.getByRole('group', { name: 'Platform' }).getByRole('link');
  const issuer = navigation.getByRole('group', { name: 'Issuer' }).getByRole('link');
  await expect(platform).toHaveCount(7);
  await expect(issuer).toHaveCount(8);
});

test('collapses navigation into a drawer on tablet widths', async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) >= 1024, 'drawer only applies below desktop width');
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await drawer.getByRole('link', { name: 'System health' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('heading', { name: 'System health' })).toBeVisible();
});

test('renders a not-found page for unknown routes', async ({ page }) => {
  await page.goto('/no/such/page');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
