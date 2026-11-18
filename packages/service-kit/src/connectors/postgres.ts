import type { Logger } from '@atlas/observability';
import pg from 'pg';
import { bindTenantContext } from '../data/scope.js';

/**
 * PostgreSQL connector.
 *
 * Each service connects with its own application_name and (in controlled environments) its own
 * database role whose privileges are limited to the schema that service owns. The pool is lazy:
 * no connection is made until first use, so startup never blocks on the database.
 */
export interface PostgresConnector {
  readonly pool: pg.Pool;
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createPostgresConnector(options: {
  url: string;
  applicationName: string;
  logger: Logger;
  maxConnections?: number;
  /** Schema owning the service's row-level-security context function (see data/scope.ts). */
  tenantContextSchema?: string;
}): PostgresConnector {
  const pool = new pg.Pool({
    connectionString: options.url,
    application_name: options.applicationName,
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 10_000,
  });
  if (options.tenantContextSchema) bindTenantContext(pool, options.tenantContextSchema);
  // Idle-client errors (e.g. database restart) must not crash the process.
  pool.on('error', (error) => options.logger.warn({ error }, 'PostgreSQL idle client error'));

  return {
    pool,
    async check() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
