import { serviceCatalog, type ServiceName } from '@atlas/contracts';
import pg from 'pg';
import { MIGRATIONS_TABLE } from './constants.js';

/**
 * Per-service database roles and least-privilege grants (ADR-012 credentials gate, Stage 1A).
 *
 *   atlas_migrator          owns every service schema; the only role that runs DDL. Used only by
 *                           the migration job; never given to a running service.
 *   atlas_<service>         one login role per schema-owning service: USAGE on its own schema and
 *                           DML on its own tables only. No DDL, no other schema, nothing in public.
 *   atlas_audit_service     as above but append-only: SELECT and INSERT, never UPDATE or DELETE.
 *
 * Role names and grants derive from the service catalogue, so migrations never mention roles or
 * passwords and a company DBA can map them onto their own role scheme.
 *
 * Provisioning (creating roles, setting passwords) needs an administrative connection and is a
 * separate step from migration; grants are re-applied by the migrator after every migration run.
 */
export const MIGRATOR_ROLE = 'atlas_migrator';

export type PrivilegeProfile = 'read-write' | 'append-only';

/** Services whose data is append-only at the database level. */
const appendOnlyServices: ReadonlySet<ServiceName> = new Set(['audit-service']);

export interface ServiceRole {
  service: ServiceName;
  schema: string;
  role: string;
  profile: PrivilegeProfile;
}

export function serviceRoleName(service: ServiceName): string {
  return `atlas_${service.replaceAll('-', '_')}`;
}

/** Environment variable holding a service's database password, e.g. DB_PASSWORD_ISSUER_SERVICE. */
export function servicePasswordVariable(service: ServiceName): string {
  return `DB_PASSWORD_${service.replaceAll('-', '_').toUpperCase()}`;
}

export function serviceRoles(): ServiceRole[] {
  return (Object.entries(serviceCatalog) as [ServiceName, (typeof serviceCatalog)[ServiceName]][])
    .filter(([, entry]) => entry.dataStores.postgresSchema !== null)
    .map(([service, entry]) => ({
      service,
      schema: entry.dataStores.postgresSchema as string,
      role: serviceRoleName(service),
      profile: appendOnlyServices.has(service) ? 'append-only' : 'read-write',
    }));
}

const ident = (value: string) => pg.escapeIdentifier(value);
const literal = (value: string) => pg.escapeLiteral(value);

async function ensureLoginRole(client: pg.Client, role: string, password: string): Promise<void> {
  if (password.length < 16) throw new Error(`Password for ${role} must be at least 16 characters`);
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const options = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  // Passwords cannot be bound as parameters in DDL; escapeLiteral quotes them safely.
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${ident(role)} ${options} PASSWORD ${literal(password)}`);
  } else {
    await client.query(`ALTER ROLE ${ident(role)} ${options} PASSWORD ${literal(password)}`);
  }
}

export interface ProvisionOptions {
  /** Administrative connection (superuser or CREATEROLE) to the ATLAS database. */
  adminUrl: string;
  migratorPassword: string;
  servicePasswords: Partial<Record<ServiceName, string>>;
  log?: (message: string) => void;
}

/**
 * Creates or updates the migrator and service roles, locks down the public schema and the
 * database, and hands ownership of existing service schemas to the migrator. Idempotent.
 */
export async function provisionDatabaseRoles(options: ProvisionOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  const client = new pg.Client({ connectionString: options.adminUrl });
  await client.connect();
  try {
    const database = (await client.query<{ db: string }>('SELECT current_database() AS db'))
      .rows[0]!.db;
    await client.query('BEGIN');

    await ensureLoginRole(client, MIGRATOR_ROLE, options.migratorPassword);
    await client.query(
      `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${ident(database)} TO ${MIGRATOR_ROLE}`,
    );

    for (const { service, role } of serviceRoles()) {
      const password = options.servicePasswords[service];
      if (!password) throw new Error(`No database password supplied for ${service}`);
      await ensureLoginRole(client, role, password);
      await client.query(`ALTER ROLE ${ident(role)} CONNECTION LIMIT 25`);
      // Bound runaway queries and idle transactions at the role level as well as in the pool.
      await client.query(`ALTER ROLE ${ident(role)} SET statement_timeout = '15s'`);
      await client.query(
        `ALTER ROLE ${ident(role)} SET idle_in_transaction_session_timeout = '30s'`,
      );
      await client.query(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(role)}`);
    }

    // Nobody but the owner may create objects in public, or connect without an explicit grant.
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query(`REVOKE ALL ON DATABASE ${ident(database)} FROM PUBLIC`);

    // Schemas created before roles existed (Stage 0) are handed to the migrator.
    for (const { schema } of serviceRoles()) {
      const present = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
      if (present.rowCount === 0) continue;
      await transferSchemaOwnership(client, schema);
      log(`schema ${schema}: owner ${MIGRATOR_ROLE}`);
    }

    await client.query('COMMIT');
    log(`provisioned ${MIGRATOR_ROLE} and ${serviceRoles().length} service roles in ${database}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function transferSchemaOwnership(client: pg.Client, schema: string): Promise<void> {
  await client.query(`ALTER SCHEMA ${ident(schema)} OWNER TO ${MIGRATOR_ROLE}`);
  const objects = await client.query<{ kind: string; name: string; args: string | null }>(
    `SELECT CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END AS kind,
            c.relname AS name, NULL AS args
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'S', 'v')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))
     UNION ALL
     SELECT 'FUNCTION', p.proname, pg_get_function_identity_arguments(p.oid)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1`,
    [schema],
  );
  for (const object of objects.rows) {
    const name = `${ident(schema)}.${ident(object.name)}`;
    const target = object.kind === 'FUNCTION' ? `${name}(${object.args ?? ''})` : name;
    await client.query(`ALTER ${object.kind} ${target} OWNER TO ${MIGRATOR_ROLE}`);
  }
}

/**
 * Grants each service role exactly its own schema. Run by the migrator after migrations, so new
 * tables are covered immediately; default privileges cover objects created later in the same way.
 * Roles that have not been provisioned are skipped (e.g. a database without per-service roles).
 */
export async function applyServiceGrants(
  client: pg.Client | pg.PoolClient,
  log: (message: string) => void = () => undefined,
): Promise<string[]> {
  const applied: string[] = [];
  for (const { schema, role, profile } of serviceRoles()) {
    const [schemaExists, roleExists] = await Promise.all([
      client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]),
      client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]),
    ]);
    if (schemaExists.rowCount === 0 || roleExists.rowCount === 0) continue;

    const s = ident(schema);
    const r = ident(role);
    const tablePrivileges =
      profile === 'append-only' ? 'SELECT, INSERT' : 'SELECT, INSERT, UPDATE, DELETE';
    await client.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
    await client.query(`REVOKE CREATE ON SCHEMA ${s} FROM ${r}`);
    await client.query(`GRANT ${tablePrivileges} ON ALL TABLES IN SCHEMA ${s} TO ${r}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${r}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO ${r}`);
    if (profile === 'append-only') {
      await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ${s} FROM ${r}`);
    }
    // Migration history belongs to the migrator alone.
    const history = await client.query('SELECT to_regclass($1) AS present', [
      `${schema}.${MIGRATIONS_TABLE}`,
    ]);
    if (history.rows[0]?.present) {
      await client.query(`REVOKE ALL ON ${s}.${ident(MIGRATIONS_TABLE)} FROM ${r}`);
    }
    // Objects created later by the migrator are granted the same way automatically.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT ${tablePrivileges} ON TABLES TO ${r}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT USAGE, SELECT ON SEQUENCES TO ${r}`,
    );
    applied.push(`${schema} → ${role} (${profile})`);
    log(`granted ${schema} to ${role} (${profile})`);
  }
  return applied;
}
