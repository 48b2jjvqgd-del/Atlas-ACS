# Security model

> The foundations below exist so that security does not have to be retrofitted. **They do not make
> ATLAS secure for production use, and ATLAS is not PCI DSS or PCI 3DS compliant.** Items marked
> _Design_ are documented but not yet implemented.

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

| Class                                          | Examples                                                                                                                       | Handling                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Restricted — authentication secrets**        | Passwords, OTP values, private keys, HSM credentials, service tokens, session cookies                                          | Never logged, never persisted in clear, never returned by APIs. Held in memory only for the minimum time.                                                 |
| **Restricted — cardholder data**               | PAN, expiry date, cardholder name with PAN                                                                                     | Never logged; masked to at most first 6 / last 4 when displayed; never stored in clear (tokenisation/encryption design required before Stage 1A storage). |
| **Restricted — sensitive authentication data** | CVV2/CVC2, track data, PIN data, authentication values (CAVV/AAV), 3DS ephemeral keys                                          | Never stored after authorisation-related use; never logged.                                                                                               |
| **Confidential**                               | Tenant configuration, fraud rules, audit records, user identities, transaction metadata without card data, device/browser data | Tenant-isolated; access-controlled; personal data handled under UK GDPR / GDPR.                                                                           |
| **Internal**                                   | Service metrics, non-sensitive logs, architecture documentation                                                                | Not public; no special handling.                                                                                                                          |
| **Public**                                     | Published API contracts, open-source code                                                                                      | —                                                                                                                                                         |

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

## Logging rules

**Never log:** passwords, OTPs, authentication secrets, tokens, private keys, full card numbers, CVV/CVC,
track data, expiry dates, authentication values, ephemeral keys, or full request/event payloads.

Log identifiers (transaction ID, tenant ID, correlation ID) and outcomes instead. The redaction list is in
[`redaction.ts`](../../packages/security/src/redaction.ts); additions are welcome, removals need review.

## Service-to-service authentication — _Design (Stage 1A / Stage 7)_

Stage 0 has none: services trust their network. `x-atlas-caller` is identification only.

Target design, in two layers:

1. **Transport — mutual TLS.** Every service presents a certificate identifying it (SPIFFE-style URI SAN
   `spiffe://atlas/<service>` or equivalent), issued by an internal CA with short-lived certificates.
   Can be provided by the platform (service mesh) or in-process; the services must not depend on which.
2. **Application — signed service tokens.** Callers obtain OAuth 2.0 client-credentials tokens (Keycloak
   locally) with `aud` set to the callee. The callee validates issuer, audience, expiry and signature, and
   authorises by caller identity per route (e.g. only `acs-core` may call `fraud-engine` assessment).

The service kit will expose both as configuration, so local development can run with relaxed settings
while every other environment runs with both enforced.

## Tenant isolation — _Design (Stage 1A)_

1. The tenant context comes from the **authenticated principal** (token claims mapped by
   identity-service), never from a client-supplied header, path or body parameter alone. A path tenant ID
   must match an authorised tenant of the principal.
2. Platform administrators act across tenants only through explicit, audited platform endpoints.
3. Every tenant-owned table has `tenant_id NOT NULL`; data access goes through repository functions that
   require a tenant context argument — there is no unscoped query helper.
4. PostgreSQL row-level security on tenant-owned tables, keyed on a per-transaction setting, as defence
   in depth.
5. Valkey keys and event envelopes (`tenantid`) carry the tenant.
6. Automated cross-tenant tests for every tenant-scoped endpoint: a principal of tenant A must receive
   `404` (not `403`, to avoid disclosing existence) for tenant B's resources.

## Audit logging — _Design (Stage 1A capture, Stage 5 presentation)_

- Every configuration change and every authentication decision produces an audit event
  (`atlas.platform.configuration-changed.v1` is the first contract), recording actor, action, resource,
  changed field **names** (never values), reason, time, correlation ID and tenant.
- audit-service stores events append-only: its runtime role has `INSERT` and `SELECT` only; no `UPDATE`
  or `DELETE`.
- Tamper evidence: each record includes a hash chained to the previous record per tenant; periodic
  anchoring of chain heads is planned.
- Authentication decisions reference the exact configuration versions used (see DATA_MODEL.md).
- Delivery uses the transactional outbox pattern so a change cannot commit without its audit event.

## Rate-limiting conventions

- Enforced at the edge (api-gateway), per client identity (IP in Stage 0; authenticated principal from
  Stage 1A).
- Defaults in [`http.ts`](../../packages/security/src/http.ts); routes may tighten, loosening needs
  review. Health probes are never limited.
- Stage 0 uses an in-memory store; a shared Valkey store is required before running more than one gateway
  instance.
- Protocol endpoints facing directory servers will use capacity-based protection rather than per-client
  limits, to avoid rejecting legitimate scheme traffic [design in Stage 1B].

## Future requirements

| Area                             | Requirement                                                                                                                                                                                                                   | Stage                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **HSM integration**              | Authentication-value generation and signing keys held in an HSM; a provider interface (PKCS#11 or vendor API) with a software implementation for simulation only; no key material in application memory longer than necessary | 7                    |
| **Key management**               | Key hierarchy, generation, rotation, revocation and destruction procedures; dual control and split knowledge where required; key inventory                                                                                    | 7                    |
| **Certificate lifecycle**        | Inventory of DS, TLS and signing certificates; automated renewal; expiry monitoring and alerting; revocation handling                                                                                                         | 7                    |
| **Mutual TLS**                   | Between services (above) and with scheme directory servers per scheme requirements [research]                                                                                                                                 | 7                    |
| **PCI DSS / PCI 3DS assessment** | Scoping, segmentation, gap assessment, remediation and formal assessment by a QSA before any production use                                                                                                                   | 7                    |
| **Data retention**               | Retention period per data class and table, aligned with scheme rules, regulation and issuer contracts; automated deletion/partition drop; legal hold                                                                          | 5                    |
| **GDPR / UK GDPR**               | Records of processing, lawful basis (issuer as controller, ATLAS operator as processor — to be confirmed), DPIA, data-subject rights tooling, international transfer assessment, breach procedures                            | 5–7                  |
| **Secrets management**           | Integration with an enterprise secret store via `*_FILE` or a provider; rotation without restart                                                                                                                              | 7                    |
| **Security testing**             | SAST, dependency and container scanning in CI; threat modelling per stage; external penetration test                                                                                                                          | 1A+ (incremental), 7 |
| **Session security**             | OIDC authorisation code + PKCE, secure cookies or BFF pattern, CSRF protection, idle/absolute timeouts, MFA for platform administrators                                                                                       | 1A                   |

## Known limitations (Stage 0)

- No authentication or authorisation anywhere: the portal and gateway are open to anyone who can reach
  them. Host ports are bound to loopback to compensate locally.
- No TLS between services or to infrastructure.
- A single PostgreSQL role is used locally for all services and migrations. Per-service credentials with
  restricted schema permissions are a **mandatory gate** before any sensitive domain functionality
  (see [DATA_MODEL.md](../architecture/DATA_MODEL.md#mandatory-gate-per-service-credentials-and-restricted-permissions)); scheduled for Stage 1A.
- `GET /v1/platform/services` is unauthenticated (it exposes service names, versions and readiness only).
- RabbitMQ consumers do not automatically resubscribe after a connection loss.

## Accepted dependency advisories

| Advisory            | Package (path)                    | Severity | Rationale                                                                                                                                                   | Review by                    |
| ------------------- | --------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| GHSA-3g3m-2fjr-6pw4 | `glob@13` (node-pg-migrate)       | Moderate | Fix requires a major upgrade not supported by node-pg-migrate 9; ATLAS does not enable node-pg-migrate's glob mode, so the vulnerable code path is not used | Next node-pg-migrate release |
| GHSA-g3hv-75wg-m249 | `minimatch@10` (ESLint, dev only) | Moderate | Fix requires a major upgrade not supported by ESLint 10; development tooling only, patterns are repository-controlled                                       | Next ESLint release          |

The CI audit gate fails on any **high** or **critical** advisory.
