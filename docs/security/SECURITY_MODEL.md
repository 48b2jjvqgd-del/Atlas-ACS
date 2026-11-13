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

| Control                                 | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Verified by                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Portal authentication                   | OIDC authorisation code + PKCE at the gateway (backend-for-frontend); state bound to the browser by a short-lived cookie; nonce checked; redirect targets restricted to same-origin paths                                                                                                                                                                                                                                                                                         | `tests/system/authentication.test.ts`, browser journeys                                                                   |
| Session handling                        | Opaque 256-bit session id in a `__Host-` HttpOnly, Secure, SameSite=Lax cookie; tokens kept server-side in Valkey, AES-256-GCM encrypted, keyed by SHA-256 of the id; idle (30 min) and absolute (8 h) expiry; access-token refresh with single-flight; a fresh session id at every sign-in (any session the browser presented is destroyed); sign-out destroys the session, revokes the refresh token at the IdP (back-channel, best effort) and returns the IdP end-session URL | `sessions.test.ts`, system tests                                                                                          |
| CSRF                                    | Session-bound token in `x-atlas-csrf` (constant-time compare) plus Origin allow-list on every state-changing request; denials audited                                                                                                                                                                                                                                                                                                                                             | system tests                                                                                                              |
| MFA for platform administrators         | Platform users have TOTP enrolled (invitations require it; granting platform roles to an existing account requires enrolment at the IdP and ends its sessions); platform-wide permissions are honoured only when the sign-in `amr` contains `otp`, in the gateway and in every service                                                                                                                                                                                            | `access.test.ts`, `identity-escalation.test.ts`, `account-lifecycle.test.ts`                                              |
| Backend RBAC                            | Granular permissions in `@atlas/contracts`; roles in identity-service; every route declares an access policy or the service refuses to start; principals resolved server-side, never from IdP role claims; privilege ceiling and no self-change (ADR-036); permission scopes and read-only system roles enforced by the database (ADR-035)                                                                                                                                        | `access.test.ts`, `permissions.test.ts`, `navigation.test.ts`, `identity-escalation.test.ts`, `database-security.test.ts` |
| Tenant isolation                        | Tenant context from the verified principal; path tenant ids only checked against it; cross-tenant → 404; strict request schemas reject smuggled tenant ids; PostgreSQL row-level security on every tenant-owned table with a database-held, set-once context (ADR-034)                                                                                                                                                                                                            | `tenant-isolation.test.ts`, `database-security.test.ts`                                                                   |
| Service-to-service authentication       | Client-credentials tokens per callee audience; callee verifies signature, issuer, audience, expiry and caller; per-route caller allow-lists; user token forwarded and verified independently; the gateway forwards only canonical paths, never `/internal/` routes (confused-deputy guard)                                                                                                                                                                                        | `access.test.ts`, `upstream-path.test.ts`, `service-security.test.ts`                                                     |
| Database least privilege (ADR-012 gate) | `atlas_migrator` owns schemas; one login role per service limited to its schema; no DDL, no `public`, no migration history; audit role append-only                                                                                                                                                                                                                                                                                                                                | `database-security.test.ts`                                                                                               |
| Audit trail                             | Every administrative change, sign-in, sign-out, session expiry, failed sign-in (from the IdP) and access denial; transactional outbox; append-only hash-chained store                                                                                                                                                                                                                                                                                                             | `audit.test.ts`, `issuer-management.test.ts`, `database-security.test.ts`                                                 |
| Rate limiting                           | Valkey-backed counters shared by gateway instances; per-address sign-in limit; per-session limits for reads, writes and sensitive changes; per-instance fallback if Valkey fails                                                                                                                                                                                                                                                                                                  | `rate-limit-store.test.ts` (unit and integration), `rate-limit.test.ts`                                                   |
| Synthetic data only (ADR-033)           | Services always write `is_synthetic = true`; database constraints refuse non-synthetic issuers and users and email addresses outside reserved domains, for every role; not configurable by `ATLAS_ENV` or any flag                                                                                                                                                                                                                                                                | `synthetic-data.test.ts`, `database-security.test.ts`, `synthetic.test.ts`                                                |
| Secrets                                 | Every new secret generated by `pnpm setup:env`, supports `_FILE`; Keycloak realm uses `${ENV}` placeholders, a test asserts no literal secret is committed                                                                                                                                                                                                                                                                                                                        | `migrations.test.ts`                                                                                                      |

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
3. Every tenant-owned table has `tenant_id NOT NULL`; data access goes through repository functions that
   require a tenant context argument — there is no unscoped query helper.
4. PostgreSQL row-level security on tenant-owned tables (`issuer.tenant`, `issuer.tenant_configuration`,
   `identity.tenant_role_assignment`, `audit.audit_record`). The context is declared by `inScope()` with
   `<schema>.begin_tenant_context()` and held by the database (ADR-034, DATA_MODEL.md). With no context
   declared in the current transaction, no tenant rows are visible.
5. Valkey keys and event envelopes (`tenantid`) carry the tenant.
6. Automated cross-tenant tests for every tenant-scoped endpoint: a principal of tenant A must receive
   `404` (not `403`, to avoid disclosing existence) for tenant B's resources.

**What row-level security guarantees, and what it does not.** Before the security remediation the
policies read the custom settings `atlas.scope` / `atlas.tenant_ids`. Any role can change those with
`set_config()`, so the guarantee was only against a query that _forgot_ its tenant predicate; a single
injected expression could widen a tenant-scoped transaction to every tenant. Now:

| Threat                                                                                       | Protected? | How / why not                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A query in tenant-scoped code that forgets its tenant predicate                              | Yes        | Policies filter every row                                                                                                                                          |
| SQL injection inside a tenant-scoped request (one statement)                                 | Yes        | `set_config`/`SET` have no effect; the context cannot be re-declared in the transaction; the context table is not readable or writable by the service role         |
| Context leaking to the next request on a pooled connection (session or transaction pooling)  | Yes        | Keyed on backend and transaction id, which is never reused                                                                                                         |
| One service reading or writing another service's schema or context                           | Yes        | No `USAGE` on other schemas; functions revoked from `PUBLIC`                                                                                                       |
| SQL injection inside a request already running platform-wide (platform administrator, relay) | No         | That transaction legitimately sees every tenant                                                                                                                    |
| A compromised service process using its own database credentials                             | **No**     | It can open its own transaction and declare platform-wide scope, as the service does for platform administrators. Only the application's authorisation stands here |

The last row cannot be closed in Stage 1A without changing the architecture; ADR-034 lists the options
for production (separate platform-wide and tenant-scoped deployables and roles, or a database-verified
context signed outside the service). The database rules that do **not** depend on the tenant context
— append-only audit, immutable configuration versions, synthetic-only records, permission-scope
rules and read-only system roles — hold even against a compromised service's credentials.

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
  a change cannot commit without its audit event and a broker outage delays but never loses events.
  A failed publish backs off the relay rather than the row, so events still leave in commit order after
  an outage; a row that keeps failing is set aside after five attempts so it cannot block the others,
  and stays in the outbox (`last_error`, `attempts`) for investigation. Unroutable events are retained
  by an alternate exchange (`atlas.events.unrouted`). Tested against a real broker outage
  (`outbox-resilience.test.ts`).
- The chain detects modification, deletion and reordering of stored records even by a database
  superuser (`audit-integrity.test.ts`). It cannot by itself detect removal of the newest records or
  records appended with valid hashes by someone holding audit-service credentials; anchoring chain
  heads outside the database addresses the first (see "Known limitations").

## Rate-limiting conventions

- Enforced at the edge (api-gateway): sign-in per client address (20 per 5 min); reads 300/min,
  writes 60/min and sensitive changes (configuration, status, roles) 20/min per session.
- Defaults in [`http.ts`](../../packages/security/src/http.ts); routes may tighten, loosening needs
  review. Health probes are never limited.
- Counters live in Valkey and are shared by every gateway instance. If Valkey fails, limiting
  degrades to per-instance counters (logged) rather than failing open or rejecting everyone.
- Behind the portal's nginx, the client address comes from `X-Forwarded-For` set by nginx and trusted
  only from `TRUSTED_PROXY_ADDRESSES`.
- Protocol endpoints facing directory servers will use capacity-based protection rather than per-client
  limits, to avoid rejecting legitimate scheme traffic [design in Stage 1B].

## Future requirements

| Area                                        | Requirement                                                                                                                                                                                                                   | Stage                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **HSM integration**                         | Authentication-value generation and signing keys held in an HSM; a provider interface (PKCS#11 or vendor API) with a software implementation for simulation only; no key material in application memory longer than necessary | 7                        |
| **Key management**                          | Key hierarchy, generation, rotation, revocation and destruction procedures; dual control and split knowledge where required; key inventory                                                                                    | 7                        |
| **Certificate lifecycle**                   | Inventory of DS, TLS and signing certificates; automated renewal; expiry monitoring and alerting; revocation handling                                                                                                         | 7                        |
| **Mutual TLS**                              | Between services (above) and with scheme directory servers per scheme requirements [research]                                                                                                                                 | 7                        |
| **PCI DSS / PCI 3DS assessment**            | Scoping, segmentation, gap assessment, remediation and formal assessment by a QSA before any production use                                                                                                                   | 7                        |
| **Data retention**                          | Retention period per data class and table, aligned with scheme rules, regulation and issuer contracts; automated deletion/partition drop; legal hold                                                                          | 5                        |
| **GDPR / UK GDPR**                          | Records of processing, lawful basis (issuer as controller, ATLAS operator as processor — to be confirmed), DPIA, data-subject rights tooling, international transfer assessment, breach procedures                            | 5–7                      |
| **Secrets management**                      | Integration with an enterprise secret store via `*_FILE` or a provider; rotation without restart                                                                                                                              | 7                        |
| **Security testing**                        | SAST, dependency and container scanning in CI; threat modelling per stage; external penetration test                                                                                                                          | 1A+ (incremental), 7     |
| **Session security**                        | Implemented in 1A (see above). Remaining: device/session listing and per-session revocation in the portal                                                                                                                     | 5                        |
| **Tenant context vs. compromised services** | Database-enforced tenant scope that a service's own credentials cannot widen (ADR-034 options: split platform-wide and tenant-scoped deployables and roles, or a database-verified signed context)                            | before production        |
| **Per-service broker credentials**          | One RabbitMQ user per service with validated `user-id`; audit-service rejects events whose producer does not match the authenticated publisher                                                                                | before production        |
| **Audit anchoring**                         | Periodic export of chain heads to an external, append-only store (WORM storage or a timestamping service), checked by verification                                                                                            | 5–7                      |
| **Non-synthetic data**                      | Only via a new ADR and migration with production data controls (ADR-033); never by configuration                                                                                                                              | after PCI/GDPR readiness |

## How to read the controls

- **Implemented controls** — the tables "What exists in Stage 0" and "What Stage 1A adds", each with the
  tests that exercise it. These are the primary controls: authentication at the IdP and gateway,
  authorisation in each service, the gateway's forwarding rules.
- **Defence in depth** — controls that hold even if a primary control has a bug: row-level security
  (against query mistakes and injection within a request), database-enforced permission scopes and
  read-only system roles, synthetic-only constraints, append-only audit privileges and triggers, the
  audit hash chain, deny-by-default route policies, `amr`-based MFA in every service as well as the
  gateway. Their exact reach is stated where they are described; RLS in particular does not contain a
  compromised service.
- **Known limitations** — below. They are accepted for Stage 1A, which is not production-ready.
- **Future production requirements** — "Future requirements" above.

## Known limitations (after Stage 1A)

- **Row-level security does not contain a compromised service.** See "Tenant isolation": a process
  holding a service's database credentials can declare platform-wide scope for its own transactions.
- **One RabbitMQ account for all services.** Any service (or anyone with the broker credentials) can
  publish an `activity-recorded` event claiming any producer; audit-service trusts the envelope's
  `source`. Per-service broker users with validated `user-id` are a production requirement.
- **Audit append rights.** Code with audit-service's database credentials can append records with
  valid hashes; the chain proves integrity of what is stored, not the authenticity of each producer.
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

The CI audit gate fails on any **high** or **critical** advisory.
