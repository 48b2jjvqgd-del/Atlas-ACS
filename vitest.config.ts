import { defineConfig } from 'vitest/config';

/**
 * Test projects:
 *  - unit:        fast, hermetic tests. No network, no infrastructure. Runs on every PR.
 *  - smoke:       spawns every service as a real OS process and probes it. No infrastructure.
 *  - integration: requires PostgreSQL, Valkey and RabbitMQ (docker compose or CI service containers).
 *  - system:      requires the full running stack (pnpm stack:up && pnpm db:seed): real Keycloak
 *                 sign-in through the portal origin, every service, Jaeger.
 *
 * Playwright E2E tests live in tests/e2e and are run by Playwright, not Vitest.
 */
const sourceConditions = { conditions: ['@atlas/source', 'node', 'import', 'default'] };

export default defineConfig({
  resolve: sourceConditions,
  ssr: { resolve: { conditions: ['@atlas/source'], externalConditions: ['@atlas/source'] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'packages/*/src/**/*.test.ts',
            'services/*/src/**/*.test.ts',
            'apps/portal/src/**/*.test.{ts,tsx}',
            'database/src/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'smoke',
          include: ['tests/smoke/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'system',
          include: ['tests/system/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
