import { expect, test } from '@playwright/test';
import { gatewayDown, signedOut, signIn } from './fixtures';

test.describe('signed out', () => {
  test('offers sign-in with ATLAS branding and the environment indicator', async ({ page }) => {
    await signedOut(page);
    await page.goto('/');
    await expect(page).toHaveTitle('ATLAS ACS');
    await expect(page.getByRole('heading', { name: 'Sign in to ATLAS' })).toBeVisible();
    const environment = page.getByTestId('environment-indicator');
    await expect(environment).toContainText('DEVELOPMENT');
    await expect(environment).toContainText('SIMULATION');
    const navigation = page.waitForURL(/\/api\/v1\/auth\/login\?returnTo=%2F/);
    await page.route('**/api/v1/auth/login*', (route) =>
      route.fulfill({ status: 200, body: 'redirecting' }),
    );
    await page.getByTestId('sign-in').click();
    await navigation;
  });

  test('explains an expired session and offers to sign in again', async ({ page }) => {
    await signedOut(page, 'Your session has expired. Please sign in again.');
    await page.goto('/platform');
    await expect(page.getByRole('heading', { name: 'Your session has ended' })).toBeVisible();
    await expect(page.getByTestId('session-expired')).toContainText('expired');
  });

  test('says so when the gateway is unreachable', async ({ page }) => {
    await gatewayDown(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ATLAS is unavailable' })).toBeVisible();
  });

  test('explains a refused sign-in on the signed-out page', async ({ page }) => {
    await page.goto('/signed-out?reason=no-account');
    await expect(page.getByTestId('signed-out-message')).toContainText('no ATLAS account');
  });
});

test.describe('permission-driven navigation', () => {
  test('a platform administrator sees the platform workspace and lands on it', async ({
    page,
    viewport,
  }) => {
    test.skip((viewport?.width ?? 0) < 1024, 'sidebar navigation is covered on desktop');
    await signIn(page, 'platform-admin');
    await page.goto('/');
    await expect(page).toHaveURL(/\/platform$/);
    await expect(page.getByRole('heading', { name: 'Platform overview' })).toBeVisible();
    await expect(page.getByTestId('signed-in-user')).toHaveText('Avery Quinn');
    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(navigation.getByRole('group', { name: 'Platform' }).getByRole('link')).toHaveCount(
      8,
    );
    // No issuer membership: no issuer workspace.
    await expect(navigation.getByRole('group', { name: 'Issuer' })).toHaveCount(0);
  });

  test('an issuer administrator never sees platform administration, even by URL', async ({
    page,
    viewport,
  }) => {
    test.skip((viewport?.width ?? 0) < 1024, 'sidebar navigation is covered on desktop');
    await signIn(page, 'northstar-admin');
    await page.goto('/');
    await expect(page).toHaveURL(/\/issuer$/);
    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(navigation.getByRole('group', { name: 'Platform' })).toHaveCount(0);
    await expect(navigation.getByRole('group', { name: 'Issuer' }).getByRole('link')).toHaveCount(
      9,
    );
    await page.goto('/platform/users');
    await expect(page).toHaveURL(/\/issuer$/);
  });

  test('customer support sees no configuration, users, fraud or compliance areas', async ({
    page,
    viewport,
  }) => {
    test.skip((viewport?.width ?? 0) < 1024, 'sidebar navigation is covered on desktop');
    await signIn(page, 'northstar-support');
    await page.goto('/issuer');
    const links = page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('group', { name: 'Issuer' })
      .getByRole('link');
    await expect(links).toHaveText([/Overview/, /Authentication/]);
  });

  test('marks unbuilt areas as placeholders with their planned stage', async ({
    page,
    viewport,
  }) => {
    test.skip((viewport?.width ?? 0) < 1024, 'sidebar navigation is covered on desktop');
    await signIn(page, 'northstar-admin');
    await page.goto('/issuer');
    const issuer = page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('group', { name: 'Issuer' });
    for (const [label, stage] of [
      ['Authentication', 'Stage 1B'],
      ['Fraud rules', 'Stage 2'],
      ['Challenges', 'Stage 3'],
      ['Compliance', 'Stage 4'],
      ['Reports', 'Stage 5'],
    ] as const) {
      await issuer.getByRole('link', { name: new RegExp(`^${label}`) }).click();
      await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
      await expect(page.getByRole('note', { name: 'Placeholder' })).toContainText(
        `Placeholder · Planned for ${stage}`,
      );
    }
  });

  test('collapses navigation into a drawer on tablet widths', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) >= 1024, 'drawer only applies below desktop width');
    await signIn(page, 'platform-admin');
    await page.goto('/platform');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await drawer.getByRole('link', { name: 'Issuers' }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Issuers' })).toBeVisible();
  });

  test('renders a not-found page for unknown routes', async ({ page }) => {
    await signIn(page, 'platform-admin');
    await page.goto('/no/such/page');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});
