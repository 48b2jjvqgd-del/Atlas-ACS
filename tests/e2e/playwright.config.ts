import { defineConfig, devices } from '@playwright/test';

/**
 * Portal E2E tests run against the production build served by `vite preview`.
 * API calls are intercepted per test (page.route) with contract-shaped responses, so the
 * suite is deterministic and needs no running services.
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 } },
    },
  ],
  webServer: {
    command: 'pnpm --filter @atlas/portal build && pnpm --filter @atlas/portal preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
