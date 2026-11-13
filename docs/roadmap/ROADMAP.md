# Roadmap

Each stage ends with a review; the next stage starts only after the project owner approves it. Stage
identifiers are referenced by the portal's placeholders, the compliance matrix and other documents, so
changing them requires updating those references. Final stage structure approved at the Stage 0 final
review (ADR-022).

| Stage | Name                                                                  | Status                                     |
| ----- | --------------------------------------------------------------------- | ------------------------------------------ |
| 0     | Independent platform foundation                                       | **Approved** (final review 2026-11-08)     |
| 1A    | Platform security and issuer foundations                              | **Security remediation — awaiting review** |
| 1B    | ACS protocol foundation and simulated Visa/Mastercard DS connectivity | Planned — **not started**                  |
| 2     | Fraud and decision engine                                             | Planned                                    |
| 3     | Challenge engine                                                      | Planned                                    |
| 4     | Compliance engine                                                     | Planned                                    |
| 5     | Reporting and analytics                                               | Planned                                    |
| 6     | Demonstration and performance testing                                 | Planned                                    |
| 7     | Migration, authorised scheme integration and certification            | Planned                                    |

Each stage is independent and has its own acceptance criteria. In particular, fraud/decisioning (2) and
challenge (3) are **not** part of Stage 1B.

## Stage 0 — Independent platform foundation

Monorepo; 13 service skeletons on a shared service kit; versioned contracts; Docker Compose
infrastructure (PostgreSQL, Valkey, RabbitMQ, Keycloak, Mailpit, Prometheus, Grafana); database migration
tooling; portal shell; security, testing and CI foundations; Codespaces configuration; documentation.
_No business logic._

## Stage 1A — Platform security and issuer foundations

Goal: no sensitive domain functionality is built until identity, isolation, least privilege and
auditability are in place and tested. Includes issuer administration and RBAC.

| #   | Deliverable                                                                                                                                                                                                                                                      | Acceptance evidence                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | **Keycloak OIDC authentication in the portal**: authorisation code + PKCE; secure session handling (backend-for-frontend or secure cookies); sign-out; MFA for platform administrators                                                                           | E2E sign-in and sign-out against Keycloak; no tokens in browser storage                                        |
| 2   | **Backend-enforced RBAC**: identity-service roles and granular permissions; every API route declares its required permission; deny by default; permission-driven portal navigation                                                                               | Unit tests per permission; API tests proving `403` without permission                                          |
| 3   | **Issuer administration and tenant isolation**: issuer-service tenant registry API (`/v1/tenants`), onboarding lifecycle, issuer configuration basics; tenant-scoped repository conventions; PostgreSQL row-level security as defence in depth                   | Integration tests per tenant-scoped table                                                                      |
| 4   | **Tenant identity from verified claims only**: tenant context derived from validated token claims mapped by identity-service; client-supplied tenant IDs are never trusted and must match an authorised tenant                                                   | Tests that tamper with path, query, body and header tenant IDs                                                 |
| 5   | **Cross-tenant access tests**: an automated suite in which a principal of tenant A receives `404` for every tenant B resource, across every tenant-scoped endpoint                                                                                               | Suite runs in CI; new endpoints must be added to it                                                            |
| 6   | **Per-service database credentials and restricted permissions**: a migrator role plus one role per service, limited to its own schema (see [DATA_MODEL.md](../architecture/DATA_MODEL.md#mandatory-gate-per-service-credentials-and-restricted-permissions))     | Integration tests proving each role is denied every other schema                                               |
| 7   | **Service-to-service authentication**: OAuth 2.0 client-credentials tokens (Keycloak locally) with a per-callee audience, validated by the service kit; per-route caller authorisation; mTLS design. Company PKI and token infrastructure integration is Stage 7 | Tests rejecting missing, expired, wrong-audience and wrong-caller tokens                                       |
| 8   | **Audit foundations for sensitive configuration changes**: `configuration-changed` events written through a transactional outbox; append-only audit-service store with a per-tenant hash chain                                                                   | Tests proving a change cannot commit without its audit event, and that audit rows cannot be updated or deleted |
| 9   | **RabbitMQ reconnection and resilience**: automatic reconnect and consumer resubscription, bounded publisher retry, retry with back-off via delay queues, poison-message handling, idempotent consumers                                                          | Integration tests that restart RabbitMQ mid-flow and assert no loss and no duplicate side effects              |
| 10  | **End-to-end OpenTelemetry tracing verification**: local OTLP collector and trace backend in Compose; trace context propagated across HTTP and RabbitMQ; correlation ID recorded on spans                                                                        | Automated test asserting one trace spans portal → gateway → service → event consumer                           |

Also in 1A: a Valkey-backed rate-limit store at the gateway.

### Stage 1A delivery status

| #   | Status                                                                                                                  | Evidence                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | Implemented: OIDC code + PKCE BFF, sessions, sign-out, TOTP for platform users                                          | `tests/system/authentication.test.ts`, browser journeys                        |
| 2   | Implemented: permission catalogue, deny-by-default route policies, permission-driven portal                             | `access.test.ts`, `permissions.test.ts`, `navigation.test.ts`, `shell.spec.ts` |
| 3   | Implemented: issuer registry, lifecycle, versioned configuration, users; RLS                                            | `issuer-management.test.ts`, `database-security.test.ts`                       |
| 4   | Implemented: tenant context from verified principals; tampering tests                                                   | `tenant-isolation.test.ts`                                                     |
| 5   | Implemented for every tenant-scoped endpoint (both directions)                                                          | `tenant-isolation.test.ts`                                                     |
| 6   | Implemented: migrator + per-service roles; append-only audit role                                                       | `database-security.test.ts`                                                    |
| 7   | Implemented: client-credentials per callee, caller allow-lists; mTLS design documented                                  | `access.test.ts`, `service-security.test.ts`                                   |
| 8   | Implemented: activity events via transactional/Valkey outbox; hash-chained append-only store                            | `database-security.test.ts`, `audit.test.ts`                                   |
| 9   | Implemented: resubscription, bounded publish retry, delayed retries, DLQ, unrouted-event retention, idempotent consumer | `messaging-resilience.test.ts` (forced connection loss)                        |
| 10  | Implemented: OTLP to Jaeger; HTTP, fetch, PostgreSQL and RabbitMQ propagation                                           | `tracing.test.ts`                                                              |
| —   | Valkey-backed rate limiting with fallback                                                                               | `rate-limit-store.test.ts`, `rate-limit.test.ts`                               |

Not done in 1A (deliberately): BIN ranges (1B), authentication activity views (1B), external
anchoring of audit chain heads, session listing per user.

### Stage 1A security remediation (review findings)

| Item                                                    | Status                                                                                                              | Evidence                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| F1 RLS context could be widened with `set_config()`     | Fixed: database-held, set-once context (ADR-034). Documented limit: does not contain a compromised service          | `database-security.test.ts`                                |
| F2 `is_synthetic` followed `ATLAS_ENV`                  | Fixed: always synthetic; database constraints; reserved email domains only (ADR-033)                                | `synthetic-data.test.ts`, `database-security.test.ts`      |
| F3 permission scopes enforced only by the application   | Fixed: catalogue in the database, triggers, read-only system roles, migrator-side synchronisation (ADR-035)         | `database-security.test.ts`, `migrations.test.ts`          |
| Gateway forwarded non-canonical paths (internal routes) | Fixed: canonical paths only, never `/internal/`                                                                     | `upstream-path.test.ts`, `service-security.test.ts`        |
| Privilege escalation through platform administration    | Fixed: privilege ceiling, no self-change via invitations or held roles (ADR-036)                                    | `identity-escalation.test.ts`                              |
| Promotion to platform roles did not require MFA at IdP  | Fixed: TOTP enrolment required, sessions ended (ADR-030 amendment)                                                  | `identity-escalation.test.ts`, `account-lifecycle.test.ts` |
| Outbox reordered events after a broker outage           | Fixed: relay-level back-off; poison rows set aside                                                                  | `outbox-resilience.test.ts`                                |
| Session fixation / sign-out at the IdP                  | Hardened: previous session destroyed at sign-in; refresh token revoked at sign-out                                  | system tests                                               |
| Remaining limitations                                   | Listed in [SECURITY_MODEL.md](../security/SECURITY_MODEL.md#known-limitations-after-stage-1a); Stage 1B not started | —                                                          |

## Stage 1B — ACS protocol foundation and simulated Visa/Mastercard DS connectivity

Prerequisite: Stage 1A complete, because 1B introduces authentication transaction data.

> **Independent-development rule.** No real employer BIN ranges, customer information, issuer data or
> other confidential information may be introduced into the independent project, in any stage. All
> issuers, BIN ranges, cardholders and transactions are synthetic.

- Confirm the EMV 3DS version baseline (compliance matrix EMV-02).
- protocol service: versioned message schemas, validation, conditional-presence rules, Error handling
  (EMV `Erro` messages) and version negotiation.
- Simulator: 3DS Server role, plus **simulated Visa and Mastercard Directory Servers**, generating
  synthetic AReqs and receiving ARes.
- visa-adapter and mastercard-adapter connected to the simulated Directory Servers; simulated
  authentication values with software keys (simulation only).
- acs-core: transaction lifecycle and state (`acs` schema, Valkey) and **AReq → ARes processing**, kept
  scheme-agnostic. Outcomes in 1B come from an explicit, deterministic simulation policy (for example,
  driven by the simulator scenario), clearly marked as non-decisioning. **Fraud scoring, rules and decision
  logic are Stage 2**; challenge flows are Stage 3.
- Issuer BIN ranges and scheme participation; portal views for issuer authentication activity and
  platform integrations. **Synthetic/test BIN ranges only** (for example, ranges reserved for testing or
  clearly fictitious ranges), flagged `is_synthetic`.
- Protocol security controls: message signing and validation, replay protection, input hardening and
  protocol-level logging rules, implemented with simulation-only software keys.
- Protocol conformance suite in `tests/protocol`.

## Stage 2 — Fraud and decision engine

- fraud-engine: versioned, issuer-scoped, testable rules and a risk assessment API.
- acs-core decision orchestration: frictionless, challenge and decline outcomes from risk inputs,
  replacing the 1B simulation policy; every decision references the exact configuration versions used.
- Rule builder in the portal, with simulation against synthetic transactions and an approval workflow.

## Stage 3 — Challenge engine

- challenge-engine: challenge sessions; browser and app challenge (CReq/CRes); RReq/RRes.
- Pluggable authentication-method providers: OTP (email via Mailpit, simulated SMS), out-of-band
  (simulated app), biometric framework.
- cardholder-service: enrolment and registered methods, under an approved data-protection design.

## Stage 4 — Compliance engine

- compliance-engine: PSD2/UK SCA exemption evaluation and scheme rule checks, sourced from the compliance
  matrix; evidence recorded with each decision.
- 3RI support. Compliance test suite in `tests/compliance`.

## Stage 5 — Reporting and analytics

- reporting-service projections; tenant-scoped and platform reports; analytics dashboards.
- Audit trail UI, chain verification and retention policies.

## Stage 6 — Demonstration and performance testing

- End-to-end demonstration scenarios driven by the simulator across both schemes, all outcomes and
  challenge methods.
- Performance and load testing against authentication-path latency budgets; resilience and failure
  testing; capacity baseline.
- Operational dashboards and alerting for the demonstration environment.

## Stage 7 — Migration, authorised scheme integration and certification

- Migration into a company-controlled environment, following
  [MIGRATION_STRATEGY.md](../MIGRATION_STRATEGY.md) and its approvals.
- Production security: HSM integration and key management, certificate lifecycle, mutual TLS (between
  services and to Directory Servers), secrets management, penetration testing, and PCI DSS / PCI 3DS
  assessment.
- Authorised scheme test connectivity, then EMVCo and scheme certification (subject to programme access).
- High availability, disaster recovery and production readiness.
