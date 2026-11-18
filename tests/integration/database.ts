import { randomBytes } from 'node:crypto';
import { migrate, provisionDatabaseRoles, serviceRoles } from '@atlas/database';
import pg from 'pg';
import { infrastructure } from './env.js';

/**
 * Throwaway databases provisioned exactly as in a real environment: roles (admin connection) →
 * migrations as atlas_migrator → grants → authorisation catalogue. Roles are cluster-wide;
 * provisioning is idempotent and uses the passwords from the environment.
 */
const adminUrl = infrastructure.databaseUrl;

const password = (variable: string) => {
  const value = process.env[variable];
  if (!value) throw new Error(`${variable} is not set: run pnpm setup:env`);
  return value;
};

export const servicePasswords: Record<string, string> = Object.fromEntries(
  serviceRoles().map(({ service }) => [
    service,
    password(`DB_PASSWORD_${service.replaceAll('-', '_').toUpperCase()}`),
  ]),
);

export interface TestDatabase {
  name: string;
  adminUrl: string;
  migratorUrl: string;
  roleUrl(service: string): string;
  urlFor(user: string, password: string): string;
  drop(): Promise<void>;
}

export async function withClient<T>(
  url: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(prefix: string): Promise<TestDatabase> {
  const name = `atlas_it_${prefix}_${randomBytes(4).toString('hex')}`;
  const urlFor = (user: string, secret: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = secret;
    url.pathname = `/${name}`;
    return url.toString();
  };
  const databaseAdminUrl = (() => {
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    return url.toString();
  })();
  const migratorUrl = urlFor('atlas_migrator', password('DB_PASSWORD_MIGRATOR'));

  await withClient(adminUrl, (client) =>
    client.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`),
  );
  await provisionDatabaseRoles({
    adminUrl: databaseAdminUrl,
    migratorPassword: password('DB_PASSWORD_MIGRATOR'),
    servicePasswords,
  });
  await migrate({ databaseUrl: migratorUrl, direction: 'up' });

  return {
    name,
    adminUrl: databaseAdminUrl,
    migratorUrl,
    urlFor,
    roleUrl: (service) =>
      urlFor(`atlas_${service.replaceAll('-', '_')}`, servicePasswords[service]!),
    drop: async () => {
      await withClient(adminUrl, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`),
      );
    },
  };
}

/**
 * Runs statements in a transaction with the row-level-security context declared exactly as
 * inScope() declares it (or not at all), then rolls back.
 */
export async function scoped<T>(
  client: pg.Client,
  schema: string,
  scope: 'all' | 'tenant' | null,
  tenants: string[],
  work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    if (scope) {
      await client.query(
        `SELECT ${pg.escapeIdentifier(schema)}.begin_tenant_context($1, $2::uuid[])`,
        [scope, tenants],
      );
    }
    return await work();
  } finally {
    await client.query('ROLLBACK');
  }
}
