import { randomUUID } from 'node:crypto';
import {
  activityRecordedV1,
  parseEvent,
  permissionCatalog,
  permissionKeys,
  systemRoles,
  type EventEnvelope,
} from '@atlas/contracts';
import type pg from 'pg';

/**
 * Authorisation catalogue synchronisation (Stage 1A).
 *
 * @atlas/contracts (packages/contracts/src/authz.ts) is the only definition of permissions, their
 * permitted scopes and the system roles. The database holds a copy so that it can enforce the
 * scope rules itself (identity migration 20261113092000_permission-scope-enforcement.sql). This
 * function keeps that copy identical to the contracts. It runs as the migrator — the owner of the
 * identity schema — after every migration run; identity-service can only read the result.
 *
 * Order matters because the database checks every step:
 *   1. upsert every catalogue entry (new permissions and widened scopes become available);
 *   2. bring system roles in line (removing permissions that are going away or narrowing);
 *   3. delete catalogue entries no longer in the contracts;
 *   4. at commit, the deferred consistency trigger rejects the whole change if any *custom* role
 *      would hold a permission outside its scope. That needs a deliberate data fix; it is never
 *      resolved by silently editing someone's role.
 *
 * Each system-role change is recorded in the audit trail through the identity-service outbox.
 */
export interface CatalogueSyncResult {
  permissionsAdded: string[];
  permissionsChanged: string[];
  permissionsRemoved: string[];
  rolesChanged: { key: string; before: string[]; after: string[] }[];
}

const sorted = (values: readonly string[]) => [...values].sort();
const same = (a: readonly string[], b: readonly string[]) =>
  sorted(a).join('\u0000') === sorted(b).join('\u0000');

export async function synchroniseAuthorisationCatalogue(
  client: pg.Client | pg.PoolClient,
  log: (message: string) => void = () => undefined,
): Promise<CatalogueSyncResult | null> {
  const present = await client.query<{ present: boolean }>(
    "SELECT to_regclass('identity.permission') IS NOT NULL AS present",
  );
  if (!present.rows[0]?.present) return null; // identity migrations not applied (or rolled back)

  const result: CatalogueSyncResult = {
    permissionsAdded: [],
    permissionsChanged: [],
    permissionsRemoved: [],
    rolesChanged: [],
  };
  await client.query('BEGIN');
  try {
    // 1. Catalogue entries.
    const existing = new Map(
      (
        await client.query<{
          key: string;
          scopes: string[];
          description: string;
          category: string;
        }>('SELECT key, scopes, description, category FROM identity.permission FOR UPDATE')
      ).rows.map((row) => [row.key, row]),
    );
    for (const key of permissionKeys) {
      const definition = permissionCatalog[key];
      const scopes = sorted(definition.scopes);
      const current = existing.get(key);
      if (!current) result.permissionsAdded.push(key);
      else if (
        !same(current.scopes, scopes) ||
        current.description !== definition.description ||
        current.category !== definition.category
      )
        result.permissionsChanged.push(key);
      else continue;
      await client.query(
        `INSERT INTO identity.permission (key, scopes, description, category) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE
           SET scopes = EXCLUDED.scopes, description = EXCLUDED.description, category = EXCLUDED.category`,
        [key, scopes, definition.description, definition.category],
      );
    }

    // 2. System roles.
    for (const [key, definition] of Object.entries(systemRoles)) {
      const desired = sorted(definition.permissions);
      const row = (
        await client.query<{
          scope: string;
          name: string;
          description: string;
          is_system: boolean;
          permissions: string[];
        }>(
          'SELECT scope, name, description, is_system, permissions FROM identity.role WHERE key = $1 FOR UPDATE',
          [key],
        )
      ).rows[0];
      if (!row) {
        await client.query(
          `INSERT INTO identity.role (key, scope, name, description, is_system, permissions)
           VALUES ($1, $2, $3, $4, true, $5)`,
          [key, definition.scope, definition.name, definition.description, desired],
        );
        result.rolesChanged.push({ key, before: [], after: desired });
        continue;
      }
      if (!row.is_system || row.scope !== definition.scope) {
        // A custom role squatting on a system key, or a scope change: both need a human decision.
        throw new Error(
          `identity.role ${key} does not match the system role definition (is_system=${row.is_system}, scope=${row.scope})`,
        );
      }
      const before = sorted(row.permissions);
      if (
        !same(before, desired) ||
        row.name !== definition.name ||
        row.description !== definition.description
      ) {
        await client.query(
          'UPDATE identity.role SET permissions = $2, name = $3, description = $4 WHERE key = $1',
          [key, desired, definition.name, definition.description],
        );
        if (!same(before, desired)) result.rolesChanged.push({ key, before, after: desired });
      }
    }
    const unknownSystem = await client.query<{ key: string }>(
      'SELECT key FROM identity.role WHERE is_system AND NOT (key = ANY ($1))',
      [Object.keys(systemRoles)],
    );
    if (unknownSystem.rows.length > 0) {
      throw new Error(
        `identity.role has system roles unknown to the catalogue: ${unknownSystem.rows.map((r) => r.key).join(', ')}`,
      );
    }

    // 3. Removed permissions.
    for (const key of existing.keys()) {
      if (Object.hasOwn(permissionCatalog, key)) continue;
      await client.query('DELETE FROM identity.permission WHERE key = $1', [key]);
      result.permissionsRemoved.push(key);
    }

    // Custom roles created before the database enforced scopes are checked explicitly as well (the
    // triggers only see rows written after they existed); this aborts the transaction.
    const invalid = await client.query<{ key: string; invalid: string[] }>(
      `SELECT key, identity.role_permission_violations(scope, permissions) AS invalid
         FROM identity.role
        WHERE cardinality(identity.role_permission_violations(scope, permissions)) > 0`,
    );
    if (invalid.rows.length > 0) {
      throw new Error(
        `Roles hold permissions outside their scope and must be corrected: ${invalid.rows
          .map((row) => `${row.key} (${row.invalid.join(', ')})`)
          .join('; ')}`,
      );
    }

    // Audit every system-role change (published by identity-service's outbox relay).
    for (const change of result.rolesChanged) {
      const envelope: EventEnvelope = parseEvent(activityRecordedV1, {
        specversion: '1.0',
        id: randomUUID(),
        source: 'urn:atlas:service:identity-service',
        type: activityRecordedV1.type,
        time: new Date().toISOString(),
        datacontenttype: 'application/json',
        dataschema: activityRecordedV1.schemaUri,
        correlationid: `catalogue-sync-${randomUUID()}`,
        data: {
          occurredAt: new Date().toISOString(),
          actor: { type: 'system', id: 'database-migration' },
          action: 'role.permissions.synchronised',
          resource: { type: 'role', id: change.key },
          outcome: 'success',
          changes: [
            {
              field: 'permissions',
              before: change.before.join(' ') || null,
              after: change.after.join(' '),
            },
          ],
          reason: 'System role definitions synchronised from the permission catalogue',
        },
      });
      await client.query(
        'INSERT INTO identity.outbox (id, event_type, envelope) VALUES ($1, $2, $3)',
        [envelope.id, envelope.type, JSON.stringify(envelope)],
      );
    }

    // 4. The deferred consistency trigger runs here; an invalid custom role aborts everything.
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }

  const changes =
    result.permissionsAdded.length +
    result.permissionsChanged.length +
    result.permissionsRemoved.length +
    result.rolesChanged.length;
  log(
    changes === 0
      ? 'authorisation catalogue up to date'
      : `authorisation catalogue synchronised: +${result.permissionsAdded.length} ~${result.permissionsChanged.length} -${result.permissionsRemoved.length} permissions, ${result.rolesChanged.length} system roles`,
  );
  return result;
}
