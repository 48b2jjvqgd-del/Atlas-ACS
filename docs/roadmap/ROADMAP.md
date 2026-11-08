# Roadmap

Each stage ends with a review; the next stage starts only after the project owner approves it. Stage
identifiers are referenced by the portal's placeholders, the compliance matrix and other documents, so
changing them requires updating those references.

| Stage | Name                                                             | Status                                                             |
| ----- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| 0     | Independent platform foundation                                  | **Approved** (with the follow-up actions recorded in DECISIONS.md) |
| 1A    | Platform security and issuer foundations                         | Planned — **not started**                                          |
| 1B    | ACS protocol foundation (simulated Directory Servers, AReq/ARes) | Planned — **not started**                                          |
| 2     | Risk and fraud rules                                             | Planned                                                            |
| 3     | Challenge flows and authentication methods                       | Planned                                                            |
| 4     | Compliance engine                                                | Planned                                                            |
| 5     | Reporting, audit and operations                                  | Planned                                                            |
| 6     | Security hardening                                               | Planned                                                            |
| 7     | Production readiness and environment migration                   | Planned                                                            |

> **Resequencing (approved at the Stage 0 review).** The former Stage 1 became **1A**, and the former
> Stages 2 (protocol layer and simulator) and 3 (authentication core and scheme adapters, frictionless)
> were combined into **1B**. The later stages moved up accordingly: 4→2, 5→3, 6→4, 7→5, 8→6, 9→7.

## Stage 0 — Independent platform foundation

Monorepo; 13 service skeletons on a shared service kit; versioned contracts; Docker Compose
infrastructure (PostgreSQL, Valkey, RabbitMQ, Keycloak, Mailpit, Prometheus, Grafana); database migration
tooling; portal shell; security, testing and CI foundations; documentation. _No business logic._

## Stage 1A — Platform security and issuer foundations

Goal: no sensitive domain functionality is built until identity, isolation, least privilege and
auditability are in place and tested.

| #   | Deliverable                                                                                                                                                                                                                                                | Acceptance evidence                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | **Keycloak OIDC authentication in the portal** — authorisation code + PKCE; secure session handling (backend-for-frontend or secure cookies); sign-out; MFA for platform administrators                                                                    | E2E sign-in/sign-out against Keycloak; no tokens in browser storage                                            |
| 2   | **Backend-enforced RBAC** — identity-service roles and granular permissions; every API route declares its required permission; deny by default                                                                                                             | Unit tests per permission; API tests proving `403` without permission                                          |
| 3   | **Issuer tenant isolation** — issuer-service tenant registry API (`/v1/tenants`), issuer configuration basics; tenant-scoped repository conventions; PostgreSQL row-level security as defence in depth                                                     | Integration tests per tenant-scoped table                                                                      |
| 4   | **Tenant identity from verified claims only** — tenant context derived from validated token claims mapped by identity-service; client-supplied tenant IDs are never trusted and must match an authorised tenant                                            | Tests that tamper with path, query, body and header tenant IDs                                                 |
| 5   | **Cross-tenant access tests** — automated suite: a principal of tenant A receives `404` for every tenant B resource, across every tenant-scoped endpoint                                                                                                   | Suite runs in CI; new endpoints must be added to it                                                            |
| 6   | **Per-service database credentials and restricted permissions** — migrator role plus one role per service limited to its own schema (see [DATA_MODEL.md](../architecture/DATA_MODEL.md#mandatory-gate-per-service-credentials-and-restricted-permissions)) | Integration tests proving each role is denied other schemas                                                    |
| 7   | **Service-to-service authentication** — OAuth 2.0 client-credentials tokens (Keycloak locally) with per-callee audience, validated by the service kit; per-route caller authorisation; design for mTLS                                                     | Tests rejecting missing, expired, wrong-audience and wrong-caller tokens                                       |
| 8   | **Audit foundations for sensitive configuration changes** — `configuration-changed` events written through a transactional outbox; append-only audit-service store with per-tenant hash chain                                                              | Tests proving a change cannot commit without its audit event, and that audit rows cannot be updated or deleted |
| 9   | **RabbitMQ reconnection and resilience** — automatic reconnect and consumer resubscription, publisher retry within bounds, retry with back-off via delay queues, poison-message handling, idempotent consumers                                             | Integration tests that restart RabbitMQ mid-flow and assert no loss and no duplicate side effects              |
| 10  | **End-to-end OpenTelemetry tracing verification** — local OTLP collector and trace backend in Compose; trace context propagated across HTTP and RabbitMQ; correlation ID recorded on spans                                                                 | Automated test asserting one trace spans portal → gateway → service → event consumer                           |

Also in 1A: permission-driven portal navigation (replacing `stageZeroPermissionCheck`) and a
Valkey-backed rate-limit store at the gateway.

## Stage 1B — ACS protocol foundation

- Confirm the EMV 3DS version baseline (compliance matrix EMV-02).
- protocol service: versioned message schemas, validation, conditional-presence rules, Erro handling and
  version negotiation.
- Simulator: 3DS Server role plus **simulated Visa and Mastercard Directory Servers**, generating synthetic
  AReqs and receiving ARes.
- acs-core: transaction lifecycle and state (`acs` schema, Valkey) and **AReq → ARes processing** for
  frictionless outcomes, kept scheme-agnostic.
- visa-adapter and mastercard-adapter against the simulated Directory Servers; simulated authentication
  values with software keys (simulation only).
- Issuer BIN ranges and scheme participation; portal views for issuer authentication activity and
  platform integrations.
- Protocol conformance suite in `tests/protocol`; performance baseline for the authentication path.

Prerequisite: Stage 1A complete, since 1B introduces authentication transaction data.

## Stage 2 — Risk and fraud rules

- fraud-engine rule model: versioned, issuer-scoped, testable rules; risk assessment API for acs-core.
- Rule builder in the portal, with simulation against synthetic transactions and an approval workflow.

## Stage 3 — Challenge flows and authentication methods

- challenge-engine: challenge sessions; browser and app challenge (CReq/CRes); RReq/RRes.
- Pluggable authentication-method providers: OTP (email via Mailpit, simulated SMS), out-of-band
  (simulated app), biometric framework.
- cardholder-service: enrolment and registered methods, with an approved data-protection design.

## Stage 4 — Compliance engine

- compliance-engine: PSD2/UK SCA exemption evaluation and scheme rule checks, sourced from the compliance
  matrix; evidence recorded with each decision.
- 3RI support. Compliance test suite in `tests/compliance`.

## Stage 5 — Reporting, audit and operations

- reporting-service projections and tenant-scoped reports; platform reports.
- Audit trail UI, chain verification, retention policies.
- Operational dashboards and alerting.

## Stage 6 — Security hardening

- HSM provider interface and key management; certificate lifecycle; mutual TLS everywhere.
- Threat model review, SAST and container scanning, penetration test, PCI DSS / PCI 3DS gap assessment.

## Stage 7 — Production readiness and environment migration

- High availability, disaster recovery, capacity and performance testing.
- Scheme and EMVCo certification preparation (subject to programme access).
- Migration into a company-controlled environment, following
  [MIGRATION_STRATEGY.md](../MIGRATION_STRATEGY.md) and its approvals.
