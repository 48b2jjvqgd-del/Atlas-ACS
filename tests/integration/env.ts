import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Integration tests read connection URLs from the environment. Locally they come from the
 * repository .env (created by `pnpm setup:env`); in CI they are set by the workflow.
 */
const envFile = join(import.meta.dirname, '..', '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Start infrastructure (pnpm infra:up) and run pnpm setup:env.`,
    );
  }
  return value;
}

export const infrastructure = {
  databaseUrl: required('DATABASE_URL'),
  valkeyUrl: required('VALKEY_URL'),
  rabbitmqUrl: required('RABBITMQ_URL'),
};

export function withCredentials(url: string, password: string): string {
  const parsed = new URL(url);
  parsed.password = password;
  return parsed.toString();
}
