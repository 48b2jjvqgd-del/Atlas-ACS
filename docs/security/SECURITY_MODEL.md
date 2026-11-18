# Security model

> The foundations below exist so that security does not have to be retrofitted. **They do not make
> ATLAS secure for production use, and ATLAS is not PCI DSS or PCI 3DS compliant.** Items marked
> _Design_ are documented but not yet implemented; items marked _Implemented (Stage 1A)_ are built and
> covered by the automated tests named alongside them.

## Principles

1. **Least data.** Do not collect, store or log data that is not needed. Never store clear PANs.
2. **Least privilege.** Each service owns only its data; each user sees only their tenant(s) and only
   the functions their permissions allow.
3. **Backend enforcement.** Authorisation and tenant isolation are enforced by services. The portal
   hiding a menu item is usability, not control.
4. **Secure defaults.** Loopback binding, restrictive headers, small body limits, timeouts everywhere,
   no wildcard CORS, fail-closed configuration.
5. **Defence in depth.** Redaction at the logger _and_ discipline in code; validation in the API _and_
   constraints in the database.
6. **Traceability.** Every configuration change and every authentication decision will be attributable
   and reconstructable (requirement H).
7. **Portability of controls.** Controls depend on standard interfaces (OIDC, mTLS, PKCS#11/KMIP, OTLP),
   not on a specific vendor or employer system.

## Data classification

| Class                                          | Examples                                                                                                                       | Handling                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Restricted — authentication secrets**        | Passwords, OTP values, private keys, HSM credentials, service tokens, session cookies                                          | Never logged, never persisted in clear, never returned by APIs. Held in memory only for the minimum time.                                            |
| **Restricted — cardholder data**               | PAN, expiry date, cardholder name with PAN                                                                                     | Never logged; masked to at most first 6 / last 4 when displayed; never stored in clear (tokenisation/encryption design required before any storage). |
| **Restricted — sensitive authentication data** | CVV2/CVC2, track data, PIN data, authentication values (CAVV/AAV), 3DS ephemeral keys                                          | Never stored after authorisation-related use; never logged.                                                                                          |
| **Confidential**                               | Tenant configuration, fraud rules, audit records, user identities, transaction metadata without card data, device/browser data | Tenant-isolated; access-controlled; personal data handled under UK GDPR / GDPR.                                                                      |
| **Internal**                                   | Service metrics, non-sensitive logs, architecture documentation                                                                | Not public; no special handling.                                                                                                                     |
| **Public**                                     | Published API contracts, open-source code                                                                                      | —                                                                                                                                                    |

## What exists in Stage 0

| Control                         | Implementation                                                                                                                                                                                                          | Verified by                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Environment-based configuration | Zod-validated env; fail closed; values never echoed                                                                                                                                                                     | `config.test.ts`, smoke test                |
| Secrets handling                | `NAME_FILE` convention; `.env` git-ignored, mode 600, generated per developer; `.env.example` placeholders only                                                                                                         | `security.test.ts`, `config.test.ts`        |
| Secure HTTP defaults            | Helmet (CSP `default-src 'none'`, nosniff, no-referrer, HSTS, CORP), no `x-powered-by`, 256 KiB body limit, request and keep-alive timeouts, `trustProxy: false`, `127.0.0.1` default bind                              | `app.test.ts`                               |
| CORS                            | Gateway only; explicit origin allow-list; never `*`                                                                                                                                                                     | `gateway.test.ts`                           |
| Rate limiting                   | Gateway: per-client limits on all API routes **including unmatched paths**; tighter limit on health aggregation; probes exempt                                                                                          | `gateway.test.ts`                           |
| Input validation                | Zod schemas at every boundary; RFC 9457 errors with field paths                                                                                                                                                         | `app.test.ts`, `contracts.test.ts`          |
| Error hygiene                   | Unexpected errors return a generic `INTERNAL_ERROR`; readiness reasons reduced to safe codes                                                                                                                            | `app.test.ts`, integration tests            |
| Secure logging                  | Key-based redaction + Luhn PAN scrubbing on every log line; no payload logging; `no-console` lint rule                                                                                                                  | `observability.test.ts`, `security.test.ts` |
| Correlation-ID safety           | Upstream IDs accepted only if well-formed (prevents header/log injection); request IDs never client-supplied                                                                                                            | `app.test.ts`                               |
| Containers                      | Non-root user, minimal production dependencies, exec-form entrypoint                                                                                                                                                    | CI `containers` job                         |
| Local infrastructure            | Host ports bound to `127.0.0.1`; generated passwords; Valkey `requirepass`                                                                                                                                              | `compose.yaml`                              |
| Supply chain                    | `pnpm audit` gate (high/critical) in CI; Dependabot (npm, actions, Docker, Compose); actions pinned by SHA; dependency build scripts denied unless allow-listed; pnpm minimum-release-age policy; lockfile frozen in CI | CI                                          |
| Portal                          | Same-origin API access (no CORS needed in production); nginx CSP `script-src 'self'`; `noindex`; no tokens in local storage (none exist yet)                                                                            | E2E, `nginx.conf`                           |

## What Stage 1A adds

| Control                                 | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Verified by                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Portal authentication                   | OIDC authorisation code + PKCE at the gateway (backend-for-frontend); state bound to the browser by a short-lived cookie; nonce checked; redirect targets restricted to same-origin paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/system/authentication.test.ts`, browser journeys                                                                   |
| Session handling                        | Opaque 256-bit session id in a `__Host-` HttpOnly, Secure, SameSite=Lax cookie; tokens kept server-side in Valkey, AES-256-GCM encrypted, keyed by SHA-256 of the id; idle (30 min) and absolute (8 h) expiry; access-token refresh with single-flight; a fresh session id at every sign-in (any session the browser presented is destroyed); sign-out destroys the session, revokes the refresh token at the IdP (back-channel, best effort) and returns the IdP end-session URL; cookie parsing never throws: a malformed cookie value is ignored without affecting the others, and a session cookie that is not a well-formed id is cleared and never looked up (final review F-12) | `sessions.test.ts`, `gateway.test.ts`, `gateway-sessions.test.ts` (fixation, malformed cookies), system tests             |
| CSRF                                    | Session-bound token in `x-atlas-csrf` (constant-time compare) plus Origin allow-list on every state-changing request; denials audited                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | system tests                                                                                                              |
| MFA for platform administrators         | Platform users have TOTP enrolled (invitations require it; granting platform roles to an existing account requires enrolment at the IdP and ends its sessions); platform-wide permissions are honoured only when the sign-in `amr` contains a second factor (`otp`), in the gateway and in every service, in every environment; there is no setting that disables this (the `PLATFORM_MFA_REQUIRED` kill switch was removed, final review L-5, ADR-030)                                                                                                                                                                                                                                | `access.test.ts`, `identity-escalation.test.ts`, `account-lifecycle.test.ts`, `config.test.ts`                            |
| Backend RBAC                            | Granular permissions in `@atlas/contracts`; roles in identity-service; every route declares an access policy or the service refuses to start; principals resolved server-side, never from IdP role claims; privilege ceiling and no self-change (ADR-036); permission scopes and read-only system roles enforced by the database (ADR-035)                                                                                                                                                                                                                                                                                                                                             | `access.test.ts`, `permissions.test.ts`, `navigation.test.ts`, `identity-escalation.test.ts`, `database-security.test.ts` |
| Tenant isolation                        | Tenant context from the verified principal; path tenant ids only checked against it; cross-tenant → 404; strict request schemas reject smuggled tenant ids; PostgreSQL row-level security on **four** tables (`issuer.tenant`, `issuer.tenant_configuration`, `identity.tenant_role_assignment`, `audit.audit_record`) with a database-held, set-once context (ADR-034), an interim boundary (see "Tenant isolation"); `issuer.outbox`, `identity.outbox` and `identity.user_account` hold tenant-attributable data **without** RLS (final review F-02, Stage 1B entry condition)                                                                                                      | `tenant-isolation.test.ts`, `database-security.test.ts`                                                                   |
| Service-to-service authentication       | Client-credentials tokens per callee audience; callee verifies signature, issuer, audience, expiry and caller; per-route caller allow-lists; user token forwarded and verified independently; the gateway forwards only canonical paths, never `/internal/` routes (confused-deputy guard)                                                                                                                                                                                                                                                                                                                                                                                             | `access.test.ts`, `upstream-path.test.ts`, `service-security.test.ts`                                                     |
| Database least privilege (ADR-012 gate) | `atlas_migrator` owns schemas; one login role per service limited to its schema; no DDL, no `public`, no migration history; audit role append-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `database-security.test.ts`                                                                                               |
| Audit trail                             | Every administrative change, sign-in, sign-out, session expiry, failed sign-in (from the IdP) and access denial; transactional outbox; append-only hash-chained store                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `audit.test.ts`, `issuer-management.test.ts`, `database-security.test.ts`                                                 |
| Rate limiting                           | Valkey-backed counters shared by gateway instances; per-address sign-in limit; per-session limits for reads, writes and sensitive changes, only for sessions that exist and are valid (bucket keyed by an HMAC of the id, never the id); any other request (no cookie, or an unknown, expired or malformed id) uses its client address's bucket, so rotating cookie values does not evade limits (final review L-2); per-instance fallback if Valkey fails                                                                                                                                                                                                                             | `rate-limit-store.test.ts` (unit and integration), `gateway-sessions.test.ts`, `rate-limit.test.ts`                       |
| Synthetic data only (ADR-033)           | Services always write `is_synthetic = true`; database constraints refuse non-synthetic issuers and users and email addresses outside reserved domains, for every role; not configurable by `ATLAS_ENV` or any flag                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `synthetic-data.test.ts`, `database-security.test.ts`, `synthetic.test.ts`                                                |
| Secrets                                 | Every new secret generated by `pnpm setup:env`, supports `_FILE`; Keycloak realm uses `${ENV}` placeholders, a test asserts no literal secret is committed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `migrations.test.ts`                                                                                                      |

## Authentication and authorisation — _Implemented (Stage 1A)_

```
browser ──cookie──▶ nginx ──▶ api-gateway (BFF) ──service token (aud=callee) + user token──▶ service
                                 │   sessions in Valkey                                     │ verifies both tokens
                                 └── OIDC code + PKCE ◀──▶ Keycloak                         └── principal from identity-service
```

1. **Who you are** — Keycloak authenticates the person (password, plus TOTP for platform users). ATLAS
   never sees a password. The gateway exchanges the code, verifies the access token is one services will
   accept (`aud=atlas-api`, `azp=atlas-gateway`) and creates a session.
2. **What you may do** — identity-service is the system of record for users, roles, permissions and
   issuer memberships. A principal is resolved from the token subject on every request (cached for at
   most 10 seconds per service); role claims in tokens are ignored.
3. **Where** — permissions held through a platform role apply to every issuer; permissions held through
   an issuer membership apply to that issuer only. Platform-only permissions (e.g. `issuer.create`,
   `platform.users.manage`) can never be granted in an issuer role. identity-service checks this, and
   since the security remediation the database enforces it independently (ADR-035): a trigger refuses
   any role permission that is unknown, duplicated or not allowed at the role's scope, for every role
   including the schema owner; the catalogue it checks against (`identity.permission`) is copied from
   `@atlas/contracts` by the migration tool and is read-only for the service; system roles are
   read-only for the service (row-level security); assignment tables only accept roles of the right
   scope (composite foreign keys). identity-service is not ready if the database catalogue differs from
   the one it was built with.
4. **Escalation guards** — nobody can change their own roles or status, through any endpoint
   (including inviting their own email address) or change a role they hold; platform administration
   is capped at the caller's own platform permissions (granting or removing platform roles, changing a
   platform user's status, defining or changing roles — ADR-036); the last active Platform Super Admin
   cannot be removed or disabled; issuer user managers can assign only issuer roles. Refusals are
   audited.
5. **Promotion** — giving an existing account platform roles requires TOTP enrolment at the IdP if it
   has no second factor and ends its IdP sessions. Until it signs in with a second factor it holds no
   platform permission (point 1 of the MFA rule above), so a failed enrolment fails closed.
6. **Disabling** an account disables it at the IdP and ends its IdP sessions. Services refuse the
   account on its next request once the principal cache (≤ 10 s) expires; the gateway then destroys the
   portal session, and token refresh fails at the IdP.

## Logging rules

**Never log:** passwords, OTPs, authentication secrets, tokens, private keys, full card numbers, CVV/CVC,
track data, expiry dates, authentication values, ephemeral keys, or full request/event payloads.

Log identifiers (transaction ID, tenant ID, correlation ID) and outcomes instead. The redaction list is in
[`redaction.ts`](../../packages/security/src/redaction.ts); additions are welcome, removals need review.

## Service-to-service authentication — _Implemented (Stage 1A); production PKI Stage 7_

**Stage split.** Local service authentication (Keycloak client-credentials tokens, validation in the
service kit, per-route caller authorisation) is implemented in **Stage 1A**. Integration with production
company PKI (mTLS certificates) and the company token infrastructure belongs to **Stage 7**.

Implemented in Stage 1A (application layer):

- Each calling service has a Keycloak client (`atlas-svc-<service>`, client credentials). It requests a
  token per callee with scope `aud-<callee>`; Keycloak issues it only if that audience was granted to
  the caller, so the call graph is enforced at issuance (gateway → identity, issuer, audit; identity →
  issuer; issuer → identity; audit → identity).
- The callee verifies signature (cached JWKS, refreshed on unknown key ids), issuer, audience = itself,
  expiry (5 s tolerance), and the caller (`azp`) against the route's allow-list. Missing, forged, expired
  and wrong-audience tokens get 401; an unlisted caller gets 403 (audited).
- `x-atlas-caller` remains identification only.

**Credential rotation design.** Client secrets come from `SERVICE_CLIENT_SECRET` / `_FILE`. Rotation:
add a second secret in the IdP (Keycloak client-secret rotation keeps the old one valid for a grace
period), replace the secret file, restart the service, then expire the old secret. Signing keys rotate at
the IdP with no ATLAS change (unknown `kid` triggers a JWKS refetch). Hot reload without restart is a
Stage 7 secrets-management item.

Production target, in two layers (the transport layer is Stage 7):

1. **Transport — mutual TLS.** Every service presents a certificate identifying it (SPIFFE-style URI SAN
   `spiffe://atlas/<service>` or equivalent), issued by an internal CA with short-lived certificates.
   Can be provided by the platform (service mesh) or in-process; the services must not depend on which.
2. **Application — signed service tokens.** Callers obtain OAuth 2.0 client-credentials tokens (Keycloak
   locally) with `aud` set to the callee. The callee validates issuer, audience, expiry and signature, and
   authorises by caller identity per route (e.g. only `acs-core` may call `fraud-engine` assessment).

The service kit will expose both as configuration, so local development can run with relaxed settings
while every other environment runs with both enforced.

## Tenant isolation — _Implemented (Stage 1A)_

1. The tenant context comes from the **authenticated principal** (token claims mapped by
   identity-service), never from a client-supplied header, path or body parameter alone. A path tenant ID
   must match an authorised tenant of the principal.
2. Platform administrators act across tenants only through explicit, audited platform endpoints.
3. Tables do **not** uniformly carry a `tenant_id NOT NULL` column (see "Row-level security coverage by
   table" below): `issuer.tenant` _is_ the tenant (its `id`); `audit.audit_record.tenant_id` is
   nullable (`NULL` marks the platform chain); the outboxes carry the tenant only inside the event
   envelope (`envelope->>'tenantid'`), not as a column; `identity.user_account` has no tenant column
   (membership is in `identity.tenant_role_assignment`). Data access in issuer-, identity- and
   audit-service goes through `inScope()`, which requires an explicit scope (a tenant list, or the
   platform-wide `systemScope`); there is no helper that runs a query without declaring one. On the
   tables without RLS that declaration has no effect in the database: only each query's own predicate
   limits what it returns.
4. PostgreSQL row-level security for tenant isolation on exactly **four** tables: `issuer.tenant`,
   `issuer.tenant_configuration`, `identity.tenant_role_assignment` and `audit.audit_record`. The
   context is declared by `inScope()` with `<schema>.begin_tenant_context()` and held by the database
   (ADR-034, DATA_MODEL.md). With no context declared in the current transaction, no rows of those
   tables are visible. (`identity.role` also has RLS, but only to keep system roles read-only; it is
   not a tenant boundary.)
   **Tables that hold tenant-attributable data without RLS:** `issuer.outbox` and `identity.outbox`
   (every tenant's audit and domain event envelopes — tenant id, actor, action, resource, before/after
   values of allow-listed fields, invited email addresses — kept for 7 days after publishing by
   `OutboxRelay`), and `identity.user_account` (every user of every issuer: email, display name,
   status; it has no tenant column — membership is in `tenant_role_assignment`). Any statement run
   with the owning service's role sees all of their rows, whatever context is declared. See the threat
   table below and "Known limitations"; the remediation is required before Stage 1B.
5. Valkey keys and event envelopes (`tenantid`) carry the tenant.
6. Automated cross-tenant tests for every tenant-scoped endpoint: a principal of tenant A must receive
   `404` (not `403`, to avoid disclosing existence) for tenant B's resources.

**What row-level security guarantees, and what it does not.** Before the security remediation the
policies read the custom settings `atlas.scope` / `atlas.tenant_ids`. Any role can change those with
`set_config()`, so the guarantee was only against a query that _forgot_ its tenant predicate; a single
injected expression could widen a tenant-scoped transaction to every tenant. Now:

| Threat                                                                                                | Protected? | How / why not                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A query in tenant-scoped code that forgets its tenant predicate — on the four RLS tables              | Yes        | Policies filter every row                                                                                                                                                                                                                                                       |
| The same, on `issuer.outbox`, `identity.outbox` or `identity.user_account`                            | **No**     | These tables have no RLS: only the query's own predicate limits what it returns                                                                                                                                                                                                 |
| SQL injection inside a tenant-scoped request (one statement) — reading or writing the four RLS tables | Yes        | `set_config`/`SET` have no effect; the context cannot be re-declared in the transaction; the context table is not readable or writable by the service role                                                                                                                      |
| SQL injection inside a tenant-scoped request — reading the outboxes or `identity.user_account`        | **No**     | No RLS: an injected sub-select in an issuer-scoped request could read other issuers' event envelopes (issuer-service, identity-service) or every user account (identity-service). No injection is known — every query is parameterised — but RLS gives no defence in depth here |
| Context leaking to the next request on a pooled connection (session or transaction pooling)           | Yes        | Keyed on backend and transaction id, which is never reused                                                                                                                                                                                                                      |
| One service reading or writing another service's schema or context                                    | Yes        | No `USAGE` on other schemas; functions revoked from `PUBLIC`                                                                                                                                                                                                                    |
| SQL injection inside a request already running platform-wide (platform administrator, relay)          | No         | That transaction legitimately sees every tenant                                                                                                                                                                                                                                 |
| A compromised service process using its own database credentials                                      | **No**     | It can open its own transaction and declare platform-wide scope, as the service does for platform administrators. Only the application's authorisation stands here                                                                                                              |

Two further rows complete the picture:

| Threat                                                                                  | Protected? | How / why not                                                                                                                  |
| --------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Removing or replacing the context with a savepoint rollback inside a scoped transaction | Yes        | `inScope()` declares at the top level before any application statement; a rolled-back subtransaction cannot undo it            |
| Declaring another tenant's id, or one that does not exist                               | **No**     | The function checks the form of the declaration only; it has no way to know which tenants the end user may act for (see below) |

### Verified properties of the tenant context

All three implementations (`issuer`, `identity`, `audit`; migrations `*_tenant-context-hardening.sql`)
are identical in structure and are exercised with each service's own credentials by
`database-security.test.ts`:

| Property                                                                      | Result                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service roles cannot read or modify the context tables                        | Confirmed for all three roles: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` are refused; the accessors return only the caller's own current context                                  |
| Service roles cannot call another service's context functions                 | Confirmed: no `USAGE` on other schemas, and `EXECUTE` revoked from `PUBLIC`                                                                                                                |
| The context cannot be re-declared within a transaction                        | Confirmed, including from an injected expression inside a statement and from inside a savepoint; `ROLLBACK TO SAVEPOINT` leaves it in place                                                |
| The context is tied to the backend and the transaction                        | Confirmed: keyed on `pg_backend_pid()` and the top-level transaction id (`xid8`, 64-bit, never reused); concurrent connections see only their own                                          |
| Pooled connections cannot leak context between requests                       | Confirmed after `COMMIT`, `ROLLBACK` and implicit single-statement transactions, and through the service pool used by `inScope()`                                                          |
| Session settings (`set_config`, `SET`) affect visibility                      | No: no policy reads a setting (`migrations.test.ts` checks every policy)                                                                                                                   |
| A compromised service can declare arbitrary tenant ids or platform-wide scope | **Yes.** Any syntactically valid tenant list, including other or non-existent tenants, and `all` in any fresh transaction (pinned by "cannot judge whether a declared scope is justified") |

### Row-level security coverage by table

Every table in the three schemas that use a tenant context, as implemented on the Stage 1A branch
(migrations under `database/migrations/`). "Tenant data" means rows attributable to one issuer.

| Table                               | Tenant data?                  | Tenant column                        | RLS                                          | Implication of the current state                                                                                                                                                           |
| ----------------------------------- | ----------------------------- | ------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `issuer.tenant`                     | Yes                           | `id` (the row is the tenant)         | **Yes**                                      | Rows outside the declared context are invisible                                                                                                                                            |
| `issuer.tenant_configuration`       | Yes                           | `tenant_id NOT NULL`                 | **Yes**                                      | As above, for reads and writes                                                                                                                                                             |
| `issuer.outbox`                     | Yes (event envelopes)         | None (`tenantid` inside `envelope`)  | **No**                                       | Any issuer-service statement sees every issuer's event envelopes (tenant id, actor, action, resource, before/after values of allow-listed fields), pending and for 7 days after publishing |
| `identity.tenant_role_assignment`   | Yes                           | `tenant_id NOT NULL`                 | **Yes**                                      | Memberships outside the declared context are invisible                                                                                                                                     |
| `identity.user_account`             | Yes (users of every issuer)   | None (membership in the table above) | **No**                                       | Any identity-service statement sees every user of every issuer: email, display name, status                                                                                                |
| `identity.outbox`                   | Yes (event envelopes)         | None (`tenantid` inside `envelope`)  | **No**                                       | Any identity-service statement sees every issuer's event envelopes, including invited email addresses, pending and for 7 days after publishing                                             |
| `identity.role`                     | No (role definitions, shared) | None                                 | Yes, but only to keep system roles read-only | Not a tenant boundary                                                                                                                                                                      |
| `identity.platform_role_assignment` | No (platform memberships)     | None                                 | No                                           | Platform data; protected by the application's authorisation and ADR-036                                                                                                                    |
| `identity.permission`               | No (catalogue)                | None                                 | No (read-only for the service by grant)      | —                                                                                                                                                                                          |
| `identity.idp_event_cursor`         | No                            | None                                 | No                                           | —                                                                                                                                                                                          |
| `audit.audit_record`                | Yes (and platform records)    | `tenant_id`, **nullable** (platform) | **Yes** (select and append)                  | Platform records are visible only with platform-wide scope                                                                                                                                 |
| `<schema>.tenant_context`           | Context store (ADR-034)       | `tenant_ids`                         | Not reachable by service roles at all        | —                                                                                                                                                                                          |

The three **No** rows for tenant data are final review finding **F-02**. They are a Stage 1B entry
condition: Stage 1B adds authentication transaction data, which would flow through these outboxes.

#### F-02 requirement (open; Stage 1B entry condition)

The same requirement as ROADMAP "Stage 1B entry conditions", item 1. Nothing here is implemented yet.

- **Required outcome:** no issuer can reach another issuer's tenant-attributable data through
  application queries, outbox records, user-directory access or other database access paths, with
  the protection enforced in the database. All tenant-attributable data is protected, including the
  exposure in `issuer.outbox`, `identity.outbox` and `identity.user_account`.
- **Threat scope: in scope.** Cross-tenant access through the platform's normal database paths:
  - request-handling queries, including incorrect or missing tenant filters;
  - database functions;
  - background jobs;
  - outbox writing, relaying, retry and retention;
  - user-directory access;
  - any other path that could expose one issuer's tenant-attributable data to another issuer.

  Work that legitimately needs cross-tenant access (for example the outbox relay, the audit
  consumer and platform administration) must declare that scope explicitly. Tests must show that
  tenant-scoped paths cannot obtain it.

- **Threat scope: separately tracked, not part of F-02.** A fully compromised service process or
  service identity: code that runs its own transactions with the service's credentials, declares
  or manipulates its own database tenant context, or misuses those credentials. The current
  database-held tenant context cannot prevent this. It validates only the form of a declaration,
  not the end user's entitlement (ADR-034, "Limits, stated plainly"; SECURITY_MODEL "The remaining
  boundary, precisely"). It is tracked as a production-hardening item ("A tenant context that a
  compromised service cannot widen"). This exclusion is **not** an acceptance of cross-tenant access
  through normal application paths, and it does not narrow the required outcome above.
- **Implementation decision (open):** the F-02 design and implementation work selects the
  mechanism, and the choice needs owner approval. The options are:
  - tenant-isolation RLS;
  - tenant-scoped database functions for the user directory;
  - data minimisation;
  - prompt purging of published outbox payloads;
  - a combination of these.

  Whatever is chosen must meet the outcome for every row. **Unpublished outbox rows are covered**:
  rows pending publication, rows awaiting retry, and rows set aside after repeated failure must be
  protected for their whole lifetime. Purging published payloads reduces retention only; **on its own
  it is not sufficient protection**.

- **Tenant-isolation control catalogue.** SECURITY_MODEL "Row-level security coverage by table" is
  extended into a catalogue. It lists every table in the tenant-context schemas, whether the table
  holds tenant-attributable data and, for each such table:
  - the database-enforced control applied, for example:
    - an RLS policy keyed on the tenant;
    - no direct privilege for the service role, with access only through tenant-scoped functions;
    - minimisation, so that the table holds no tenant-attributable content;
  - the tests that prove the control.
- **Automated catalogue test**, run against the migrated database. It fails if:
  - any table in those schemas is missing from the catalogue, including tables added later;
  - a table catalogued as holding tenant-attributable data has no control recorded;
  - the recorded control is not present in the database (for example RLS not enabled or no
    policy, or the service role still holding direct privileges on a function-only table).
- **Automated cross-tenant tests** for every catalogued table and every in-scope path. Using the
  service's own database role in a tenant-A context:
  - reading tenant-B rows returns nothing, and writing, changing or deleting them fails;
  - for the outboxes, this covers rows in every state (pending, retrying, set aside, and published
    but retained);
  - for minimised tables, a test asserts that no tenant-attributable content is stored.
- No claim of universal RLS coverage, or of complete tenant isolation, until this is independently
  reviewed.

### The remaining boundary, precisely

**Interim boundary.** The database-held tenant context (ADR-034) is an **interim** control for Stage
1A, not the target design. The context is declared by the service process itself, using the same
database role for tenant-scoped requests and for legitimately platform-wide work. The database can
therefore check only the _form_ of a declaration, not whether the end user is entitled to it. The
model has three limitations:

- **It covers only the four RLS tables** listed above.
- **It defends only against defects inside a request.** It stops a query that forgets its tenant
  predicate, and an injected statement that tries to widen or replace the declared context. It does
  not stop code that can open its own transactions with the service's credentials.
- **Correctness depends on the application.** Whether the declared scope is the right one depends
  entirely on application code (the verified principal, the route's access policy, `tenantScope()`
  and `scopeFor()`).

The production design (ADR-034 options: split platform-wide and tenant-scoped deployables and roles,
and/or a context signed by a component the service does not control) is not chosen yet.

**What the database prevents.** For every statement executed by a service role: seeing or changing a
row of the four RLS tables outside the declared context (not rows of the outboxes or
`identity.user_account`, which have no RLS — see point 4 above); widening, replacing or removing the context once declared in
a transaction; carrying a context into another transaction or connection; using another service's
schema, tables or context function; reading or writing the context table; disabling RLS or triggers
(the service role owns nothing). Independently of the context, and even against the service's own
credentials: updating or deleting audit records; changing configuration versions; creating
non-synthetic issuers or users; giving a tenant role a platform-only, unknown or duplicate
permission; changing system roles or the permission catalogue.

**What the application prevents.** Which scope is declared. A request's scope is derived from the
verified principal — a token verified against the IdP, the principal resolved by identity-service —
after the route's deny-by-default access policy has checked the permission and, for tenant routes,
that the path tenant is one of the principal's issuers (otherwise `404`, audited). `tenantScope()` and
`scopeFor()` only ever receive tenant ids that passed that check. `systemScope` (platform-wide) is used
by service-internal work, by endpoints whose policy requires a platform-wide permission, and by two
user endpoints whose policy requires only an active user: `GET /v1/identity/roles` (reads
`identity.role`, which holds no tenant data) and `POST /v1/identity/users/:userId/status`, which reads
the target's memberships platform-wide and then authorises in the handler (platform user management
for platform users; `issuer.users.manage` in _every_ issuer of an issuer user) before it changes
anything.

**What a compromised service process could still do.** Code running with a service's database
credentials (remote code execution in the service, a malicious dependency, a leaked password) can open
its own transactions and declare any scope in **its own schema**: read and change every issuer and
configuration (issuer-service), every user, membership and custom role (identity-service, within the
permission-scope rules), or read every audit record and append records with valid hashes
(audit-service). It cannot reach another service's schema, and the context-independent rules above
still hold. Containing a compromised process is the job of the controls around it (separate
credentials per service, no shared roles, monitoring), not of RLS.

The database is not the only thing a service's credentials reach. A compromised **identity-service**
also holds Keycloak `realm-management` rights (`manage-users`, `view-users`, `view-events`) and is the
system of record for role assignments, so it amounts to control of the platform — see "Known
limitations". Every service also holds the shared Valkey and RabbitMQ credentials (same section).

**Why platform-wide scope remains necessary.** Several legitimate operations are not tied to one
tenant: the audit consumer appends events for every issuer (its insert policy requires `all`);
identity-service resolves a principal by reading the user's memberships across all issuers;
platform administrators (platform-wide permission, MFA required) list and manage every issuer and
user; access-denied events with no business change are recorded in their own platform-wide
transaction. Each of these
runs in the same service process, with the same database role, as tenant-scoped requests.

**Why the database cannot tell legitimate from compromised.** The database sees a login role and a
function call. A platform administrator's request and a compromised process produce the same call,
with the same credentials, on the same connection pool. The end user's identity and permissions are
verified in the application; nothing reaches the database that it could check independently, and any
proof the service merely passes along could be fabricated by the same service if the service is what
holds or mints it. The same is true of tenant lists: the database does not know the user, so it
cannot know which tenants they belong to.

**What would close the gap** (none is chosen for Stage 1A; ADR-034):

1. **Split platform-wide and tenant-scoped work** into separate deployables with separate database
   roles, and split the context function so that only the platform/worker role can declare `all`. A
   compromised tenant-facing process could then no longer declare platform-wide scope, but could still
   declare any tenant list.
2. **A context the service cannot mint**: the gateway or identity-service issues a short-lived signed
   context (user, scope, tenant ids, expiry, nonce) with a key the service does not hold, and
   `begin_tenant_context()` verifies the signature and refuses replays. This also closes arbitrary
   tenant lists; a compromised service could still replay contexts of requests it actually receives,
   for their lifetime. It needs a signature-verification extension and key management in the database.
3. Combining 1 and 2, plus per-service broker credentials and audit anchoring, is the production
   recommendation. Per-tenant database roles are not recommended: they
   do not scale to many issuers and still leave platform-wide work needing a role that sees everything.

## Audit logging — _Implemented (Stage 1A); authentication decisions from Stage 1B_

- Every audited action produces `atlas.platform.activity-recorded.v1`: event id, time, actor, issuer
  (when tenant-scoped), action, resource, outcome (`success`/`failure`/`denied`), correlation id,
  reason, and before/after values for an explicit allow-list of non-sensitive fields per resource.
  Field names that look like credentials are rejected by the contract itself; tokens, passwords,
  session ids and card data are never recorded (asserted by `audit.test.ts`).
- Cross-tenant denials are recorded on the platform chain, not in the target issuer's trail, so one
  issuer never learns about another issuer's users.
- audit-service stores events append-only: its runtime role has `INSERT` and `SELECT` only; no `UPDATE`
  or `DELETE`.
- Tamper evidence: each record's SHA-256 hash covers its canonical content and the previous hash in
  its chain (one per issuer, one platform chain); `GET /v1/audit/chains/{chain}/verify` recomputes it.
  Triggers reject UPDATE, DELETE and TRUNCATE for every role. Anchoring chain heads externally is planned.
- Authentication decisions reference the exact configuration versions used (see DATA_MODEL.md).
- Delivery uses a transactional outbox (PostgreSQL services) or a durable Valkey outbox (gateway), so
  a change cannot commit without its audit event, and on the **producer side** a broker outage delays
  but does not lose events (the row stays in the outbox until the broker confirms it). On the
  **broker side** every queue is a quorum queue and every move between queues (retry, return from a
  delay queue, dead-lettering) is confirmed by the target before the source releases the message
  (at-least-once dead-lettering, ADR-038), so a broker restart does not lose events in the main, delay
  or dead-letter queues; the dead-letter queue has no delivery limit, so inspecting a dead letter cannot
  delete it (`broker-restart.test.ts`, `messaging-migration.test.ts`; final review F-01, fixed;
  [MESSAGING.md](../architecture/MESSAGING.md)). One gap remains: a gateway crash followed by a
  container _recreate_ can strand the one event it was relaying in
  `outbox:processing:<old hostname>` (final review F-03, open). Delivery is at-least-once (a relay that stops between the broker's confirm and its commit publishes
  again) and **ordering is best effort, not guaranteed** (ADR-037): one relay publishes the rows it can
  see in insertion order and a broker outage of any length does not reorder them, but overlapping
  transactions can be relayed in a different order from the one they started in, several relay
  instances publish concurrently, and consumers process concurrently and retry later. A row that keeps
  failing is set aside only once a row behind it has published (so an outage is never mistaken for a
  poison row); it stays in the outbox (`last_error`, `attempts`), is retried with its own back-off and
  is logged at error level. The gateway's Valkey outbox behaves the same way (`outbox:set-aside`;
  unreadable entries kept in `outbox:unreadable`). Unroutable events are retained by an alternate
  exchange (`atlas.events.unrouted`). Tested with several relay instances, concurrent transactions, a
  broker outage, a relay crash and poison rows (`outbox-resilience.test.ts`, `outbox-ordering.test.ts`,
  `valkey-outbox.test.ts`).
- The audit store does not depend on arrival order: records are keyed on the event id (duplicates
  ignored) and each chain is hashed in the order records are stored (`sequence`), under a per-chain
  lock. A chain therefore proves the integrity of what was stored, in storage order; `occurred_at` is
  the producer's time and may not be monotonic along a chain.
- The chain detects modification, deletion and reordering of stored records even by a database
  superuser (`audit-integrity.test.ts`). It cannot by itself detect removal of the newest records or
  records appended with valid hashes by someone holding audit-service credentials; anchoring chain
  heads outside the database addresses the first (see "Known limitations").

## Rate-limiting conventions

- Enforced at the edge (api-gateway): sign-in per client address (20 per 5 min); reads 300/min,
  writes 60/min and sensitive changes (configuration, status, roles) 20/min per session. A request
  gets a per-session bucket only when its session exists, decrypts under the gateway's key and has
  not expired; the bucket key is an HMAC of the id (never the id or a prefix of it). Requests
  without such a session (no cookie, or an unknown, expired or malformed id) share their client
  address's bucket, so rotating cookie values cannot mint new identities (final review L-2).
- **Buckets are per session, not per account.** Authenticated buckets are keyed by session;
  unauthenticated buckets by client address. A user who signs in several times (several browsers,
  or signing out and in again) holds several sessions and so several buckets. These limits
  therefore bound each session and each address, not each account; a strict per-account limit is
  not provided. Sign-in itself is limited per address, which bounds how quickly new sessions (and so
  new buckets) can be created from one address.
- The bucket key is HMAC-SHA-256 of the session id under a key derived from
  `SESSION_ENCRYPTION_KEY` with HKDF-SHA-256 and a purpose-specific context
  (`atlas/api-gateway/rate-limit-identity/hmac-sha256/v1`); the session encryption key itself is
  never used as an HMAC key, and the derived key is never logged or exposed in configuration.
- Defaults in [`http.ts`](../../packages/security/src/http.ts); routes may tighten, loosening needs
  review. Health probes are never limited.
- Counters live in Valkey and are shared by every gateway instance. If Valkey fails, limiting
  degrades to per-instance counters (logged) rather than failing open or rejecting everyone.
- Behind the portal's nginx, the client address comes from `X-Forwarded-For` set by nginx and trusted
  only from `TRUSTED_PROXY_ADDRESSES`.
- Protocol endpoints facing directory servers will use capacity-based protection rather than per-client
  limits, to avoid rejecting legitimate scheme traffic [design in Stage 1B].

## Future requirements

| Area                                        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Stage                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **HSM integration**                         | Authentication-value generation and signing keys held in an HSM; a provider interface (PKCS#11 or vendor API) with a software implementation for simulation only; no key material in application memory longer than necessary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 7                                                                         |
| **Key management**                          | Key hierarchy, generation, rotation, revocation and destruction procedures; dual control and split knowledge where required; key inventory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 7                                                                         |
| **Certificate lifecycle**                   | Inventory of DS, TLS and signing certificates; automated renewal; expiry monitoring and alerting; revocation handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 7                                                                         |
| **Mutual TLS**                              | Between services (above) and with scheme directory servers per scheme requirements [research]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 7                                                                         |
| **PCI DSS / PCI 3DS assessment**            | Scoping, segmentation, gap assessment, remediation and formal assessment by a QSA before any production use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 7                                                                         |
| **Data retention**                          | Retention period per data class and table, aligned with scheme rules, regulation and issuer contracts; automated deletion/partition drop; legal hold                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 5                                                                         |
| **GDPR / UK GDPR**                          | Records of processing, lawful basis (issuer as controller, ATLAS operator as processor — to be confirmed), DPIA, data-subject rights tooling, international transfer assessment, breach procedures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 5–7                                                                       |
| **Secrets management**                      | Integration with an enterprise secret store via `*_FILE` or a provider; rotation without restart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 7                                                                         |
| **Security testing**                        | SAST, dependency and container scanning in CI; threat modelling per stage; external penetration test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 1A+ (incremental), 7                                                      |
| **Session security**                        | Implemented in 1A (see above). Remaining: device/session listing and per-session revocation in the portal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 5                                                                         |
| **Tenant context vs. compromised services** | Database-enforced tenant scope that a service's own credentials cannot widen (ADR-034 options: split platform-wide and tenant-scoped deployables and roles, or a database-verified signed context)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | before production                                                         |
| **Per-service broker credentials**          | One RabbitMQ user per service, with least-privilege configure, write and read permissions on the exchanges, queues and routing patterns it needs; shared administrator credentials removed from service runtime configuration; validated `user-id`, and audit-service rejects events whose producer does not match the authenticated publisher (producer identity and provenance not taken from self-declared metadata); automated tests                                                                                                                                                                                                                                                                       | **before Stage 1B** (Stage 1B entry condition)                            |
| **RLS gaps: outboxes and user accounts**    | **Required outcome:** no issuer can reach another issuer's tenant-attributable data through any database access path, enforced in the database. This covers `issuer.outbox` and `identity.outbox` (including unpublished rows) and `identity.user_account`. Mechanism open: RLS keyed on the event's or membership's tenant, the user directory reached only through tenant-scoped functions, data minimisation, published payloads purged promptly, or a combination; purging alone is not sufficient. Required: a tenant-isolation control catalogue with an automated catalogue test, and automated cross-tenant tests. Threat scope and ADR-034 boundary as in "F-02 requirement" under "Tenant isolation" | **before Stage 1B** (F-02, Stage 1B entry condition)                      |
| **Durable consumer retries**                | Delayed retries that survive a broker restart (at-least-once dead-lettering into a target that is available, or another retry mechanism); `broker-restart.test.ts` must pass in CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | before merge: **met** (ADR-038; passed locally and in CI run 44400443275) |
| **Per-service Valkey credentials**          | One Valkey ACL user per service that needs Valkey, limited to its own key prefix and commands (gateway: sessions, login state, rate limits, outbox); no Valkey credential for services that do not use it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **before Stage 1B** (F-04, Stage 1B entry condition)                      |
| **Issuer-role privilege ceiling**           | Issuer user managers may assign or remove only issuer roles whose permissions they hold in that issuer; this applies to system and custom issuer roles; the last active `issuer-administrator` of an issuer cannot be removed, disabled or demoted; regression tests for both (today ADR-036 caps platform administration only; ADR-036 needs the revision it records before acceptance)                                                                                                                                                                                                                                                                                                                       | **before Stage 1B** (F-08, Stage 1B entry condition)                      |
| **Identity-provider administration**        | Narrow identity-service's Keycloak rights to the operations it performs (fine-grained admin permissions or a separate, minimal provisioning component); separate privileged identity operations (password/OTP reset, role assignment to platform roles) from the request-serving process; alert on IdP admin events                                                                                                                                                                                                                                                                                                                                                                                            | before production                                                         |
| **Audit anchoring**                         | Periodic export of chain heads to an external, append-only store (WORM storage or a timestamping service), checked by verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 5–7                                                                       |
| **Non-synthetic data**                      | Only via a new ADR and migration with production data controls (ADR-033); never by configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | after PCI/GDPR readiness                                                  |

## How to read the controls

- **Implemented controls** — the tables "What exists in Stage 0" and "What Stage 1A adds", each with the
  tests that exercise it. These are the primary controls: authentication at the IdP and gateway,
  authorisation in each service, the gateway's forwarding rules.
- **Defence in depth** — controls that hold even if a primary control has a bug: row-level security
  (against query mistakes and injection within a request, on the four RLS tables only — not the
  outboxes or `identity.user_account`), database-enforced permission scopes and
  read-only system roles, synthetic-only constraints, append-only audit privileges and triggers, the
  audit hash chain, deny-by-default route policies, `amr`-based MFA in every service as well as the
  gateway. Their exact reach is stated where they are described; RLS in particular does not contain a
  compromised service.
- **Known limitations** — below. They are accepted for Stage 1A, which is not production-ready.
- **Future production requirements** — "Future requirements" above.

## Known limitations (after Stage 1A)

- **Row-level security does not contain a compromised service.** See "Tenant isolation": a process
  holding a service's database credentials can declare platform-wide scope for its own transactions.
- **Row-level security covers four tables, not every table with tenant data.** `issuer.outbox`,
  `identity.outbox` (event envelopes of every issuer, kept 7 days after publishing) and
  `identity.user_account` (every user of every issuer) have no RLS. A query mistake or SQL injection in
  an issuer-scoped request of issuer-service or identity-service could read them across issuers.
  No such defect is known (all queries are parameterised). Remediation is required **before Stage
  1B**, which adds authentication transaction data that will flow through these outboxes.
- **Messaging: single broker node, duplicates, recovery latency.** (F-01, the loss of consumer
  retries on a broker restart, is fixed: ADR-038.) The local broker is one node, so a lost volume
  loses queued events; production needs a three-node cluster. Delivery is at least once: duplicates
  are expected and absorbed by idempotent consumers. A message that expires from a delay queue while
  the broker is recovering can take up to the broker's 3-minute dead-letter confirm timeout to arrive.
  Rolling back to the version-1 queue topology reintroduces the at-most-once loss window. See
  [MESSAGING.md](../architecture/MESSAGING.md#limitations).
- **One Valkey credential for all services.** Compose gives every service the same `VALKEY_URL`
  (database 0, one password), including services that do not use Valkey. Any compromised service can
  therefore: delete, reorder or inject entries in the gateway's audit outbox (`outbox`,
  `outbox:processing:*`, `outbox:set-aside`; plain JSON), so gateway audit events (sign-in, sign-out,
  session expiry, CSRF and access denials) can be suppressed or forged as long as they claim a
  registered producer; delete portal sessions and pending sign-in state (forced sign-out for
  everyone); and reset or inflate rate-limit counters. Session records are AES-256-GCM encrypted and
  authenticated with a key only the gateway holds, so a session cannot simply be read or forged — but
  that does not remove the availability and audit-integrity risks. Per-service Valkey ACL users with
  least-privilege key and command patterns are a **Stage 1B entry condition** (final review F-04).
- **identity-service can administer every identity-provider account.** Its Keycloak service account
  holds `realm-management` roles `manage-users`, `view-users` and `view-events` (required today for
  invitations, enabling/disabling accounts, requiring TOTP enrolment, ending sessions and ingesting
  failed sign-ins). `manage-users` also allows resetting any user's password, removing their second
  factor, changing required actions and ending sessions. Combined with identity-service's write access
  to role assignments, a compromise of identity-service (code execution, a malicious dependency, its
  client secret) could take over any account, including a Platform Super Admin, and grant itself
  platform roles: effectively a platform takeover. This sits outside the database boundary described
  under "Tenant isolation". Narrower Keycloak rights and separating privileged identity operations are
  production requirements; changing the roles now affects invitation, disable and MFA-promotion flows
  and is not part of Stage 1A.
- **One RabbitMQ account for all services, with administrator rights.** Every service uses the same
  broker user, which `ensure-user.sh` tags `administrator` with configure, write and read permission
  on every resource of the `/` vhost: any service can also declare, bind, purge or delete any queue
  or exchange (including the audit consumer's queues and dead-letter queues), and use the management
  API. Any service (or anyone with the broker credentials) can
  publish an `activity-recorded` event claiming any producer; audit-service trusts the envelope's
  `source`. Per-service broker users with validated `user-id` (and audit-service checking the authenticated
  publisher against the event's producer) are a **Stage 1B entry condition**.
- **Audit append rights.** Code with audit-service's database credentials can append records with
  valid hashes; the chain proves integrity of what is stored, not the authenticity of each producer.
- **No privilege ceiling for issuer roles (final review F-08).** ADR-036 caps platform
  administration only. Within an issuer, any holder of `issuer.users.manage` can assign any issuer
  role, including roles with permissions they do not hold themselves (for example `issuer-administrator` to
  a second account). They can also remove or disable the issuer's last active
  `issuer-administrator`: unlike the
  last Platform Super Admin, nothing protects that account. Self-change is still refused. An issuer
  privilege ceiling and last-issuer-administrator protection are a **Stage 1B entry condition**.
- **Inviting an existing address into another issuer.** An issuer user manager who invites an email
  address that already has an ATLAS account learns that the account exists, and its display name is
  reused. Memberships are still per issuer, and the manager gains no access to the other issuer.
- **Disabled accounts** keep their (useless) gateway session record until its next use or expiry; the
  services refuse it within the 10-second principal cache window.
- **Sign-out at the IdP** relies on refresh-token revocation (best effort) plus the browser following
  the end-session redirect; if both fail, the IdP session lives until its own timeout.
- No TLS between services or to infrastructure locally (mTLS and company PKI are Stage 7). Service
  ports are bound to loopback; anyone on the host can reach `/health`, `/info` and `/metrics`, which
  expose no tenant data. Application routes all require service tokens.
- Keycloak runs from a pre-built local image (`start --optimized`) over plain HTTP with local-only
  caches and a bootstrap admin with a generated password. It is not a production configuration.
- The local demo accounts share one generated password and a pre-enrolled TOTP secret (from `.env`).
- Permission changes take up to 10 seconds to reach other services (principal cache).
- Events are not ordered end to end (ADR-037). No Stage 1A consumer needs order; a future consumer
  that applies state changes must use a per-aggregate version, not arrival order.
- Audit events from producers are at-least-once; the consumer deduplicates by id. Chain heads are not
  yet anchored outside the database, so a database superuser could rebuild a chain consistently.
- Failed sign-in events are ingested from Keycloak every 30 seconds (not real time).
- Access-denied events are not sampled: a scripted attacker could inflate the audit trail (they are
  rate limited at the gateway).

## Accepted dependency advisories

| Advisory            | Package (path)                    | Severity | Rationale                                                                                                                                                   | Review by                    |
| ------------------- | --------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| GHSA-3g3m-2fjr-6pw4 | `glob@13` (node-pg-migrate)       | Moderate | Fix requires a major upgrade not supported by node-pg-migrate 9; ATLAS does not enable node-pg-migrate's glob mode, so the vulnerable code path is not used | Next node-pg-migrate release |
| GHSA-g3hv-75wg-m249 | `minimatch@10` (ESLint, dev only) | Moderate | Fix requires a major upgrade not supported by ESLint 10; development tooling only, patterns are repository-controlled                                       | Next ESLint release          |

The CI audit gate (`node scripts/audit-gate.mjs`) fails on any **high** or **critical** advisory,
except a temporary exception recorded below **and** in `scripts/audit-exceptions.json` (none is
currently in force). The gate applies
an exception only when it positively establishes that the advisory is inside its scope — the same
advisory, package and severity, only the recorded versions, at least one finding with at least one
dependency path, every path under the recorded development/build prefixes, and absent from the
production-only audit (which may never contain a high or critical advisory). Missing, empty or
malformed evidence — audit output, advisories, severities, findings, paths — fails the gate, and so
does a missing or malformed exception register (an empty list is valid: no exceptions). The exception expires at **00:00 UTC on its review date** and is not accepted on
that date; the gate also fails once a patched version is published or once the exception no longer
matches anything. "No fix exists" must be stated by the audit output itself: pnpm 12 reports it as
`patched_versions: null` together with `patched_versions_unpublished: true` (verified on 2026-11-17 against the raw
`pnpm audit --json` output for GHSA-fc5q-39xc-vjpf, and documented in the pnpm changelog); anything
else — a missing field, a bare `null`, npm's older `"<0.0.0"`, another type, an empty or
contradictory value, or a patched range — fails the gate (final review F-07). Moderate advisories do not fail the gate (unchanged). `pnpm audit:deps` runs the same gate locally;
`pnpm audit:deps:raw` runs the plain `pnpm audit`, which reports every advisory, including the moderate
ones above.

### Temporary high-severity exceptions

None in force (`scripts/audit-exceptions.json` lists no exceptions).

### Removed exceptions

| Advisory                              | Accepted   | Removed    | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GHSA-fc5q-39xc-vjpf (CVE-2026-112366) | 2026-11-17 | 2026-11-18 | **GitHub withdrew the advisory** on 2026-11-18 at 15:38 UTC, so `pnpm audit` no longer reports it and the gate failed closed on the stale exception ("exception no longer matches any advisory"). This is a withdrawal, not a fix: **no dependency was upgraded or patched** — `picomatch` is still 4.0.7 (development/build paths only). Removing npm, npx and their bundled `picomatch` from the runtime images stays in place and is still checked by CI |
