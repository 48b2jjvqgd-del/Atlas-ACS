# Data model

> Stage 0 defines **ownership and principles**, and one table (`issuer.tenant`). The ACS data model is
> designed stage by stage, not up front.

## Ownership boundaries

ATLAS uses one PostgreSQL instance locally, with **one schema per owning service**. A schema is created
and changed only by its owner's migrations, and in controlled environments is accessed only through the
owner's database role.

| Schema       | Owner              | Planned contents                                                    | Sensitivity  |
| ------------ | ------------------ | ------------------------------------------------------------------- | ------------ |
| `issuer`     | issuer-service     | Tenants, issuer configuration, BIN ranges, scheme participation     | Confidential |
| `acs`        | acs-core           | Authentication transactions and their lifecycle state               | Restricted   |
| `fraud`      | fraud-engine       | Rule definitions, rule versions, risk assessment records            | Confidential |
| `compliance` | compliance-engine  | Exemption policies, compliance evaluation records                   | Confidential |
| `challenge`  | challenge-engine   | Challenge sessions, method attempts                                 | Restricted   |
| `cardholder` | cardholder-service | Enrolment, registered authentication methods (never clear PANs)     | Restricted   |
| `identity`   | identity-service   | Portal users ↔ IdP subjects, roles, permissions, tenant memberships | Confidential |
| `reporting`  | reporting-service  | Read-optimised projections built from events                        | Confidential |
| `audit`      | audit-service      | Append-only audit records                                           | Confidential |

`protocol`, `visa-adapter`, `mastercard-adapter` and `api-gateway` own no relational data.
Valkey keys are namespaced by owner prefix (`atlas:<service>:`), enforced by the connector.

### Rules

1. **No shared writes.** A service never writes to another service's schema.
2. **No cross-schema reads or foreign keys.** References across ownership boundaries are by value (e.g.
   `tenant_id uuid`), validated through the owner's API or its events. This keeps every schema
   relocatable to its own database without change.
3. **Data flows through contracts.** Another service's data is obtained by calling its versioned API or
   by consuming its events into a local projection.
4. **Reporting builds projections**; it never queries source schemas.
5. A unit test asserts that no two services claim the same schema, and a migration test asserts that no
   migration references another owner's schema.

The single-instance, schema-per-service layout is a local and early-stage convenience (see
[ADR-012](../decisions/DECISIONS.md#adr-012-schema-per-service-in-one-postgresql-instance)). Moving an
owner to a dedicated database requires only a different `DATABASE_URL`.

### Mandatory gate: per-service credentials and restricted permissions

Stage 0 uses a single local PostgreSQL role for every service and for migrations. This is accepted
**only** while no service holds sensitive data. Before any sensitive domain functionality is built —
cardholder data, authentication transactions or decisions, fraud rules, identity and permission data,
or audit records — the following must be implemented and tested (scheduled for Stage 1A):

| Role                                                                  | Privileges                                                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atlas_migrator` (one per environment, used only by the migrator job) | Owns every service schema; DDL                                                                                                                                       |
| `atlas_<service>` (one per owning service)                            | `USAGE` on its own schema; `SELECT`, `INSERT`, `UPDATE`, `DELETE` on its own tables and sequences only; no DDL; no access to any other schema; no access to `public` |
| `atlas_audit_service`                                                 | As above but `INSERT` and `SELECT` only on audit tables (append-only)                                                                                                |

- Each service receives its own credentials (`DATABASE_URL` / `DATABASE_URL_FILE`); no service is given
  another service's credentials, and runtime services never receive migrator credentials.
- `CREATE` on the `public` schema is revoked from `PUBLIC`.
- Default privileges are set so tables created by future migrations are granted to the owning service
  role automatically.
- Integration tests prove that each service role is denied access to every other service's schema.

## What exists in Stage 0

`issuer.tenant` — the tenancy foundation
([migration](../../database/migrations/issuer/20261106000000_create-tenant.sql)):

| Column                     | Type          | Notes                                                                              |
| -------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `id`                       | `uuid` PK     | `gen_random_uuid()`; the tenant identifier used everywhere                         |
| `slug`                     | `text` unique | Lowercase kebab-case, 2–63 chars; display/routing only, never an authorisation key |
| `display_name`             | `text`        | 1–200 chars                                                                        |
| `status`                   | `text`        | `onboarding` · `active` · `suspended` · `offboarded`                               |
| `is_synthetic`             | `boolean`     | `true` for development/simulation data                                             |
| `created_at`, `updated_at` | `timestamptz` | `updated_at` maintained by trigger                                                 |

Constraints are enforced in the database as well as in the API contract
([`tenantSummarySchema`](../../packages/contracts/src/http/v1/issuer.ts)).

## Modelling principles for future stages

- **Tenant scoping.** Every tenant-owned row carries `tenant_id uuid NOT NULL`, is indexed on it, and is
  queried only with a tenant predicate supplied by the authenticated context (see
  [SECURITY_MODEL.md](../security/SECURITY_MODEL.md#tenant-isolation)). PostgreSQL row-level security
  will be added as defence in depth.
- **Identifiers** are UUIDs generated by the owner; natural keys (slugs, BINs) are unique constraints, not
  primary keys.
- **Time** is `timestamptz`, stored in UTC.
- **Enumerations** are `text` with `CHECK` constraints (cheap to extend by migration) rather than
  PostgreSQL enum types (awkward to change).
- **Extensibility without destabilisation.**
  - New fields are added as nullable columns or with defaults; existing readers are unaffected.
  - Issuer-specific configuration that varies by issuer or scheme is stored as typed, versioned
    configuration documents (`jsonb` validated by a versioned Zod schema at the service boundary), with
    first-class columns for anything queried, indexed or constrained.
  - New schemes, authentication methods and integrations are new rows/configuration and new adapter
    code — never schema changes to unrelated tables.
- **Configuration history.** Configuration that affects authentication decisions (rules, exemption
  policies, method settings) is versioned and immutable once active: changes create a new version, so
  every decision can be traced to the exact configuration that produced it (requirement H).
- **Cardholder data.** Clear PANs are not stored. Where an account reference is required it will be a
  token or keyed hash, with the design subject to approval and PCI DSS scoping before implementation.
- **Retention** is defined per table (see SECURITY_MODEL.md) and implemented with partitioning by time
  where volumes require it.

## Managing database changes

Every schema change is a versioned migration — no manual DDL, in any environment.

- Location: `database/migrations/<schema>/<UTC yyyymmddhhmmss>_<kebab-name>.sql`, with
  `-- Up Migration` and `-- Down Migration` sections. Plain SQL is used so changes are reviewable by
  DBAs and portable to other tooling.
- Each owner has its own history table, `<schema>.pgmigrations`, so owners migrate and roll back
  independently.
- Runner: `node-pg-migrate`, per owner, each run in a single transaction with ordering checks.
- Commands: `pnpm db:migrate`, `pnpm db:status`, `pnpm db:rollback --owner <schema> [--count n]`
  (owner is mandatory; production rollback additionally requires `--allow-production-rollback`).
- Migrations run as a separate job (`migrator` image) with `MIGRATION_DATABASE_URL` — a privileged role
  distinct from runtime roles.
- **Rollback strategy:** every migration ships a Down section, exercised in CI (up → down → up). In
  shared environments, prefer **roll-forward** fixes; destructive changes use expand–contract:
  1. _Expand_: add new structures, backfill, dual-write.
  2. Migrate readers.
  3. _Contract_: remove old structures in a later release, once no deployed version uses them.
     A migration must never break the currently deployed version of its owner.
- Applied migrations are never edited; write a new migration instead.

## Development seed data

`database/seeds/development/<schema>/NNN_<name>.sql`, run with `pnpm db:seed`:

- synthetic data only, flagged `is_synthetic = true`, with a `SYNTHETIC DATA ONLY` header (tested);
- refused unless `ATLAS_ENV` is `development`, `test` or `simulation`, before any connection is opened;
- idempotent (`ON CONFLICT DO NOTHING`), one transaction per owner;
- never creates schema — seeds run after migrations.
