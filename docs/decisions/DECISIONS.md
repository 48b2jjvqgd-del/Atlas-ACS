# Architecture decisions

Decision log in lightweight ADR form.

- **Confirmed** — agreed before Stage 0.
- **Accepted** — proposed during Stage 0 and approved by the project owner at the Stage 0 review
  (2026-11-08).
- **Accepted (general approval)** — covered by the owner's approval of the overall Stage 0 architecture
  and implementation, but not individually named in that review.
- **Proposed** — awaiting the owner's decision.

| ADR | Decision                                                               | Status                                               |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| 001 | Greenfield Visa and Mastercard integration                             | Confirmed                                            |
| 002 | Independent microservices from the beginning                           | Confirmed                                            |
| 003 | One combined portal for platform and issuer users                      | Confirmed                                            |
| 004 | Backend-enforced tenant isolation and granular permissions             | Confirmed                                            |
| 005 | Open-source-first technology                                           | Confirmed                                            |
| 006 | Docker-based local development                                         | Confirmed                                            |
| 007 | Portability between independent and company environments               | Confirmed                                            |
| 008 | Versioned database migrations and API contracts                        | Confirmed                                            |
| 009 | Comprehensive automated testing                                        | Confirmed                                            |
| 010 | A working simulation environment, not a static demo                    | Confirmed                                            |
| 011 | Retain TypeScript 6                                                    | Accepted                                             |
| 012 | Schema per service in one PostgreSQL instance, with a credentials gate | Accepted (with condition)                            |
| 013 | Plain-SQL migrations with per-owner history                            | Accepted (general approval)                          |
| 014 | RFC 9457 problem details and a `data`/`meta` envelope                  | Accepted (general approval)                          |
| 015 | CloudEvents envelope over a RabbitMQ topic exchange                    | Accepted (general approval)                          |
| 016 | Additional `packages/service-kit` and `tests/smoke`                    | Accepted                                             |
| 017 | One parameterised Dockerfile; Compose file at repository root          | Accepted                                             |
| 018 | `@prometheus-io/client` instead of `prom-client`                       | Accepted (verified)                                  |
| 019 | Valkey instead of Redis                                                | Accepted — implemented                               |
| 020 | Dependency maturity and supply-chain policy                            | Accepted, plus a proposed security-release exception |
| 021 | Documentation file locations                                           | Accepted                                             |
| 022 | Stage resequencing: 1A and 1B                                          | Accepted; renumbering of later stages proposed       |

---

## Confirmed decisions

### ADR-001 Greenfield Visa and Mastercard integration

Scheme behaviour is implemented from scratch in separate adapters, without proprietary scheme code or
existing implementations. _Rationale:_ independence, licensing clarity, and a scheme-agnostic core
(requirement A).

### ADR-002 Independent microservices from the beginning

Thirteen services, each independently buildable, configurable, deployable and testable. _Rationale:_
the authentication path and administrative functions have different latency, scaling, hardening and
change profiles; retrofitting boundaries later is expensive. _Consequence:_ a shared service kit is
required to keep per-service overhead low (ADR-016).

### ADR-003 One combined portal

A single React application serves platform administrators and issuer users, with permission-driven
navigation. _Rationale:_ one design system and codebase; access is enforced by the backend.

### ADR-004 Backend-enforced tenant isolation and granular permissions

See [SECURITY_MODEL.md](../security/SECURITY_MODEL.md#tenant-isolation). Delivered in Stage 1A.

### ADR-005 Open-source-first

Prefer maintained, permissively licensed components; record every licence
([register](../MIGRATION_STRATEGY.md#dependency-and-licence-register)).

### ADR-006 Docker-based local development

All infrastructure runs via Docker Compose; services run either on the host or in containers.

### ADR-007 Portability

No cloud-provider or employer dependency; configuration via environment and secret files; standard
protocols at every integration point. See [MIGRATION_STRATEGY.md](../MIGRATION_STRATEGY.md).

### ADR-008 Versioned migrations and contracts

See [DATA_MODEL.md](../architecture/DATA_MODEL.md) and [CONVENTIONS.md](../architecture/CONVENTIONS.md).

### ADR-009 Comprehensive automated testing

Unit, smoke, integration and E2E suites gate every change in CI.

### ADR-010 Working simulation environment

A simulator (Stage 1B) acting as 3DS Server and simulated Visa and Mastercard Directory Servers will
drive real flows end to end.

---

## Stage 0 decisions

### ADR-011 Retain TypeScript 6 — _Accepted_

**Context.** TypeScript 7.0 (native compiler) is the latest release, but `typescript-eslint` 8.x supports
only `>=4.8.4 <6.1.0`. **Decision.** Pin `typescript ~6.0.3`. Do not upgrade to a TypeScript major that
the linting toolchain does not support. **Consequence.** Type-aware linting works. Dependabot will
propose a 7.x upgrade; it is to be declined until `typescript-eslint` declares support, and then
evaluated as its own change.

### ADR-012 Schema per service in one PostgreSQL instance — _Accepted, with condition_

**Context.** The brief requires avoiding a shared database that every service can modify. **Decision.**
For now, one PostgreSQL instance, one schema per owning service, each with its own migration history.
**Alternatives.** Database per service (stronger isolation, more local overhead); shared schema
(rejected). **Consequence.** Any owner can move to a dedicated database by changing its connection URL
— no code change, because cross-schema references are forbidden and tested.

**Condition (owner's requirement).** Individual database credentials for each service, with permissions
restricted to that service's own schema, must be implemented and tested **before any sensitive domain
functionality is built**. This is a Stage 1A deliverable and a prerequisite for Stage 1B. Specification:
[DATA_MODEL.md](../architecture/DATA_MODEL.md#mandatory-gate-per-service-credentials-and-restricted-permissions).

### ADR-013 Plain-SQL migrations with per-owner history — _Accepted (general approval)_

**Decision.** `node-pg-migrate` (MIT) running `.sql` files with Up/Down sections, one directory and one
history table per owner, executed by a separate migrator job. **Rationale.** SQL is reviewable by DBAs
and portable to other tools (Flyway, Liquibase) if a company environment mandates them; per-owner
history keeps services independent.

### ADR-014 RFC 9457 problem details and a `data`/`meta` envelope — _Accepted (general approval)_

**Decision.** Errors use the IETF standard problem format with `code` and `correlationId` extensions;
successes use `{ data, meta }`. EMV 3DS protocol endpoints are exempt. **Rationale.** A standard error
format is understood by common tooling and portable across environments.

### ADR-015 CloudEvents envelope over a RabbitMQ topic exchange — _Accepted (general approval)_

**Decision.** Events use CloudEvents 1.0 structured mode; one durable topic exchange, routing key = event
type, quorum queues owned by one consumer, dead-letter queues, confirm-mode publishing. **Rationale.**
A CNCF standard envelope keeps events portable to other brokers (Kafka, cloud buses) via CloudEvents
bindings. Reconnection and resilience are a Stage 1A deliverable.

### ADR-016 Additional `packages/service-kit` and `tests/smoke` — _Accepted_

Add `packages/service-kit` (the Fastify service foundation) so `packages/shared` stays dependency-free and
usable in the browser; add `tests/smoke` for process-level start/health/shutdown tests of built output.

### ADR-017 One parameterised Dockerfile; Compose file at repository root — _Accepted_

`infrastructure/docker/service.Dockerfile` builds any service via `--build-arg SERVICE`; the build stage is
shared and cached, and `pnpm deploy` produces a per-service production image. `compose.yaml` lives at the
repository root; its supporting configuration lives under `infrastructure/`.

### ADR-018 `@prometheus-io/client` instead of `prom-client` — _Accepted (verified)_

**Decision.** Use `@prometheus-io/client` `^0.16.1`.

**Verification (2026-11-08):**

| Check           | Finding                                                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provenance      | Published from `github.com/prometheus/client_js`. The original `siimon/prom-client` repository now redirects there, so this is the same project under the Prometheus organisation, not a fork. npm marks `prom-client` deprecated with "replaced by @prometheus-io/client". |
| Maintenance     | Repository active (last push 2026-11-01; merges in Sep–Oct 2026); not archived; maintainers include Prometheus team members. Four releases since Aug 2026.                                                                                                                  |
| Build integrity | npm SLSA v1 provenance attestation present for 0.16.1.                                                                                                                                                                                                                      |
| Licence         | Apache-2.0 (package and repository).                                                                                                                                                                                                                                        |
| Dependencies    | Two runtime dependencies: `@opentelemetry/api` (Apache-2.0) and `tdigest` (MIT).                                                                                                                                                                                            |
| Compatibility   | Supports Node 22/24/26. API used by ATLAS (`Registry`, `Histogram`, `collectDefaultMetrics`, `contentType`) is covered by unit tests; a real Prometheus 3.16 server scrapes all 13 services successfully.                                                                   |
| Adoption        | About 0.93 million weekly downloads, against about 13.6 million for the deprecated name, which is still migrating.                                                                                                                                                          |

**Risk.** It is versioned 0.x, so minor releases may break compatibility. The `^0.16.1` range only admits
0.16.x patches; minor upgrades arrive as reviewed Dependabot pull requests.

### ADR-019 Valkey instead of Redis — _Accepted, implemented_

**Context.** Redis 8 is licensed under a choice of AGPLv3, RSALv2 or SSPLv1, none of them permissive.
**Decision.** Use **Valkey** (Linux Foundation, BSD-3-Clause), which is compatible with the Redis
protocol. **Implementation:**

- Compose service `valkey` using `valkey/valkey:9.1.3-alpine`, with authentication (`--requirepass`),
  append-only persistence and a `valkey-cli` health check.
- Configuration renamed `VALKEY_URL` (and `VALKEY_URL_FILE`) and `VALKEY_PASSWORD`. The URL scheme stays
  `redis://` / `rediss://`, the protocol scheme Valkey implements.
- Service-kit dependency, readiness check and connector renamed to `valkey`; the catalogue field is now
  `valkeyPrefix`.
- Client library unchanged: `ioredis` (MIT). Compatibility was verified by the integration suite
  against Valkey 9.1.3: connection, authentication failure, key-prefix isolation, and service readiness.

Grafana (AGPLv3, used unmodified as a separate tool) and RabbitMQ (MPL-2.0) remain on the licence
register for review.

### ADR-020 Dependency maturity and supply-chain policy — _Accepted_

Pin exact container image versions and GitHub Action commit SHAs. Adopt releases at least about 2 weeks
old; pnpm's minimum-release-age policy enforces this for npm. Deny dependency install scripts except an
explicit allow-list. Fail CI on high or critical advisories. Run Dependabot for npm, Actions, Docker and
Compose. Accepted moderate advisories are recorded in SECURITY_MODEL.md.

**Proposed exception (needs the owner's confirmation): security releases.** A release that fixes a
published vulnerability may be adopted before it is two weeks old, recording the advisory as
justification. **Applied once:** Valkey 9.1.3, published 2026-10-26 (13 days old when adopted), is a
security release fixing GHSA-f4q9-j22m-xqq9 (heap buffer overflow). Pinning the older 9.1.2 would
have deliberately deployed a known-vulnerable version.

### ADR-021 Documentation file locations — _Accepted_

The brief's named documents live in the matching `docs/` subfolders. `PROJECT_OVERVIEW.md`,
`DEVELOPMENT.md` and `MIGRATION_STRATEGY.md` are at the `docs/` root, and `CONVENTIONS.md` has been added.

### ADR-022 Stage resequencing — _Accepted; later renumbering proposed_

**Decision (owner).** The next stages are **1A — Platform security and issuer foundations** and
**1B — ACS protocol foundation**, covering simulated Visa and Mastercard Directory Servers and AReq/ARes
processing. Neither stage has started.

**Consequence (proposed, needs confirmation).** 1A takes the former Stage 1 plus the owner's additional
security requirements. 1B absorbs the former Stages 2 and 3. The remaining stages are renumbered
4→2, 5→3, 6→4, 7→5, 8→6, 9→7 so there are no gaps. The portal placeholders, compliance matrix,
protocol, security and migration documents have been updated to match. See
[ROADMAP.md](../roadmap/ROADMAP.md).
