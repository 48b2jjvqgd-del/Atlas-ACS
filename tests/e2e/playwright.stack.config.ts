import { defineConfig, devices } from '@playwright/test';

/**
 * Full-stack journeys: a real browser against the running stack (pnpm stack:up && pnpm db:seed),
 * signing in through Keycloak's own pages. Runs serially: journeys share seeded accounts.
 */
export default defineConfig({
  testDir: './specs-stack',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-stack' }]]
    : 'list',
  use: {
    baseURL: process.env.SYSTEM_TEST_PORTAL_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      grepInvert: /@tablet/,
    },
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 } },
      grep: /@tablet/,
    },
  ],
});
