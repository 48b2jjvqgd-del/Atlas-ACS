# Architecture decisions

Decision log in lightweight ADR form.

- **Confirmed** — agreed before Stage 0.
- **Accepted** — proposed during Stage 0 and approved by the project owner at the Stage 0 review
  (2026-11-08).
- **Accepted (general approval)** — approved by the owner as general architectural decisions at the
  Stage 0 final review (2026-11-08); documentation and rationale retained.
- **Proposed** — awaiting the owner's decision. ADR-024 to ADR-032 are proposed with Stage 1A and are
  implemented on the Stage 1A branch for review.

| ADR | Decision                                                                     | Status                             |
| --- | ---------------------------------------------------------------------------- | ---------------------------------- |
| 001 | Greenfield Visa and Mastercard integration                                   | Confirmed                          |
| 002 | Independent microservices from the beginning                                 | Confirmed                          |
| 003 | One combined portal for platform and issuer users                            | Confirmed                          |
| 004 | Backend-enforced tenant isolation and granular permissions                   | Confirmed                          |
| 005 | Open-source-first technology                                                 | Confirmed                          |
| 006 | Docker-based local development                                               | Confirmed                          |
| 007 | Portability between independent and company environments                     | Confirmed                          |
| 008 | Versioned database migrations and API contracts                              | Confirmed                          |
| 009 | Comprehensive automated testing                                              | Confirmed                          |
| 010 | A working simulation environment, not a static demo                          | Confirmed                          |
| 011 | Retain TypeScript 6                                                          | Accepted                           |
| 012 | Schema per service in one PostgreSQL instance, with a credentials gate       | Accepted (with condition)          |
| 013 | Plain-SQL migrations with per-owner history                                  | Accepted (general approval)        |
| 014 | RFC 9457 problem details and a `data`/`meta` envelope                        | Accepted (general approval)        |
| 015 | CloudEvents envelope over a RabbitMQ topic exchange                          | Accepted (general approval)        |
| 016 | Additional `packages/service-kit` and `tests/smoke`                          | Accepted                           |
| 017 | One parameterised Dockerfile; Compose file at repository root                | Accepted                           |
| 018 | `@prometheus-io/client` instead of `prom-client`                             | Accepted (verified)                |
| 019 | Valkey instead of Redis                                                      | Accepted — implemented             |
| 020 | Dependency maturity and supply-chain policy, with security-release exception | Accepted                           |
| 021 | Documentation file locations                                                 | Accepted                           |
| 022 | Final stage structure (1A, 1B, 2–7)                                          | Accepted (owner's final structure) |
| 023 | GitHub Codespaces development configuration                                  | Accepted                           |
| 024 | Backend-for-frontend sessions at the gateway                                 | Proposed (Stage 1A)                |
| 025 | Database roles provisioned outside migrations; grants from the catalogue     | Proposed (Stage 1A)                |
| 026 | identity-service is the system of record for authorisation                   | Proposed (Stage 1A)                |
| 027 | Service tokens per callee audience; user token forwarded and re-verified     | Proposed (Stage 1A)                |
| 028 | One audit event, outbox delivery, hash-chained append-only store             | Proposed (Stage 1A)                |
| 029 | Jaeger as the local trace backend                                            | Proposed (Stage 1A)                |
| 030 | A second factor is required for platform-wide permissions                    | Proposed (Stage 1A)                |
| 031 | Event contracts may have several producers                                   | Proposed (Stage 1A)                |
| 032 | Cross-tenant access returns 404 and is audited on the platform chain         | Proposed (Stage 1A)                |

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

**Security-release exception — _Accepted at the Stage 0 final review_.** A release that fixes a
security vulnerability may be adopted before it reaches the two-week age threshold, provided all of the
following are met and recorded:

1. **Verified upstream security advisory**: the advisory is confirmed at the upstream project's
   official source, not only in release notes or third-party reports.
2. **Exact version pinning**: the patched version is pinned exactly, never as a range or a floating tag.
3. **Recorded justification**: an entry in the register below names the advisory, its severity, the
   affected and fixed versions, and why waiting would be worse.
4. **Full relevant automated testing**: every automated suite that exercises the component passes on the
   patched version.
5. **Documented approval**: the project owner's approval is recorded in the register.

Register of exceptions:

| Component                             | Version          | Age when adopted               | Advisory (verified upstream)                                                                                                                                                          | Severity | Affected → fixed     | Justification                                                                                                                                                                                                                                       | Testing                                                                                                                          | Approval                                        |
| ------------------------------------- | ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Valkey (`valkey/valkey:9.1.3-alpine`) | 9.1.3, exact tag | 13 days (published 2026-10-26) | GHSA-f4q9-j22m-xqq9, confirmed in the `valkey-io/valkey` repository security advisory (published 2026-10-26). Not yet listed in the GitHub global advisory database at time of check. | High     | `<= 9.1.2` → `9.1.3` | Heap buffer overflow in cluster Pub/Sub message construction that could allow an authenticated client to execute code. ATLAS runs Valkey standalone (not cluster), so exposure is low, but adopting 9.1.2 would knowingly pin a vulnerable release. | Unit, smoke, integration (Valkey connectivity, authentication failure, key-prefix isolation, readiness), E2E, full Compose stack | Project owner, Stage 0 final review, 2026-11-08 |

### ADR-021 Documentation file locations — _Accepted_

The brief's named documents live in the matching `docs/` subfolders. `PROJECT_OVERVIEW.md`,
`DEVELOPMENT.md` and `MIGRATION_STRATEGY.md` are at the `docs/` root, and `CONVENTIONS.md` has been added.

### ADR-022 Final stage structure — _Accepted_

**Decision (owner, Stage 0 final review).** The roadmap is:

| Stage | Name                                                                               |
| ----- | ---------------------------------------------------------------------------------- |
| 1A    | Platform security and issuer foundations (includes issuer administration and RBAC) |
| 1B    | ACS protocol foundation and simulated Visa/Mastercard DS connectivity              |
| 2     | Fraud and decision engine                                                          |
| 3     | Challenge engine                                                                   |
| 4     | Compliance engine                                                                  |
| 5     | Reporting and analytics                                                            |
| 6     | Demonstration and performance testing                                              |
| 7     | Migration, authorised scheme integration and certification                         |

Fraud/decisioning and challenge implementation are **not** absorbed into Stage 1B; each stage keeps its
own acceptance criteria. Neither 1A nor 1B has started.

**Consequences.**

- Stage 1B processes AReq → ARes with an explicit, deterministic simulation outcome policy. Real risk
  decisioning arrives in Stage 2.
- The production security hardening previously scheduled as its own stage (HSM, key management,
  certificate lifecycle, mutual TLS, PCI assessment) is placed in **Stage 7**, alongside migration and
  certification, where production keys, scheme connectivity and a target environment exist.
  Service-to-service authentication (tokens) and the mTLS design remain in Stage 1A.
- **Approval condition (owner, 2026-11-08).** Stage 7 holds only production-specific security
  hardening. All foundational security controls are implemented in **Stage 1A**, and protocol security
  controls in **Stage 1B**; neither may be deferred to Stage 7.
- Performance testing, previously part of the protocol and production stages, is placed in **Stage 6**.
- Portal placeholders, the compliance matrix, and the protocol, security and migration documents are
  updated to match. See [ROADMAP.md](../roadmap/ROADMAP.md).

### ADR-023 GitHub Codespaces development configuration — _Accepted_

**Decision (owner request).** Add `.devcontainer/devcontainer.json`:

- Node 24 dev container image, pinned by digest; Docker-in-Docker feature pinned at 4.1.3.
- `postCreateCommand` installs pnpm 12.16.1, installs dependencies (frozen lockfile) and creates a local
  `.env`. Infrastructure is not started automatically.
- Labelled port forwarding for the portal, gateway and tools. Data-store and broker ports
  (PostgreSQL, Valkey, AMQP, SMTP) are not auto-forwarded. Forwarded ports remain private (the
  Codespaces default).

The Vite dev and preview servers additionally allow the Codespaces forwarding domain, and only when
running inside a Codespace (`CODESPACES=true`), so the portal is reachable through port forwarding while
host-header protection stays in place everywhere else.

**Restart policies (owner request, after the final review).** Every long-running Compose container now
uses `restart: unless-stopped`: infrastructure (PostgreSQL, Valkey, RabbitMQ, Keycloak, Mailpit,
Prometheus, Grafana), the portal and all services. So the stack comes back on its own after a
Codespace or Docker restart. Containers you stop deliberately (`docker compose stop`, `pnpm stack:down`)
stay stopped. The one-off `migrate` job keeps `restart: 'no'`. No other infrastructure was changed.

---

## Stage 1A decisions (proposed, implemented for review)

### ADR-024 Backend-for-frontend sessions at the gateway — _Proposed_

**Decision.** api-gateway is a confidential OIDC client (authorisation code + PKCE) and keeps the
tokens server-side in Valkey, encrypted with AES-256-GCM. The browser holds one opaque HttpOnly
`__Host-` cookie. CSRF: session-bound header token plus Origin check.

**Why.** No token in browser storage (roadmap acceptance criterion), refresh tokens never exposed to
scripts, and one place to enforce idle/absolute expiry. **Alternatives:** a public SPA client with
tokens in memory (exposes tokens to XSS, refresh handling in the browser); a separate BFF service
(another hop with no benefit at this scale). **Consequence:** the gateway depends on Valkey; it fails
closed (503) when Valkey is unavailable.

### ADR-025 Database roles provisioned outside migrations; grants from the catalogue — _Proposed_

**Decision.** Implements the ADR-012 gate. Roles and passwords are created by a separate provisioning
step with an administrative connection (`pnpm db:provision`); migrations run as `atlas_migrator`, which
then applies grants computed from the service catalogue. Migration SQL never names roles.

**Why.** Passwords never appear in migration files or history; the same migrations work under a
company DBA's role scheme; grants cannot drift from ownership. **Alternative:** roles in migrations
(couples schema history to credentials and cluster-wide objects).

### ADR-026 identity-service is the system of record for authorisation — _Proposed_

**Decision.** The IdP authenticates; identity-service stores users, roles, permissions and issuer
memberships and resolves a principal per request (cached ≤ 10 s in each service). Role or group claims
in tokens are not used. Users are provisioned at the IdP by identity-service through the Keycloak Admin
API, with an emailed invitation; ATLAS never handles passwords. System roles and the permission catalogue are
synchronised into the database by the migration tool, not by the running service (ADR-035).

**Why.** Tenant memberships and fine-grained permissions belong to ATLAS, change often and must be
audited; keeping them out of tokens means changes apply within seconds rather than at token renewal, and
the IdP stays replaceable (company IdP in Stage 7). **Cost:** one cached lookup per request.

### ADR-027 Service tokens per callee audience; user token forwarded and re-verified — _Proposed_

**Decision.** Each calling service obtains a client-credentials token per callee (scope `aud-<callee>`);
Keycloak only grants audiences configured for the caller. Callees verify audience, issuer, expiry and
caller per route. For user requests the gateway also forwards the user's access token
(`x-atlas-user-token`), which each service verifies itself.

**Why.** A stolen token is only good for one callee; the call graph is enforced twice; a compromised
gateway cannot invent users. **Alternative:** gateway-asserted identity headers (trusted subsystem) —
rejected as weaker. mTLS is the Stage 7 transport layer (SECURITY_MODEL.md).

### ADR-028 One audit event, outbox delivery, hash-chained append-only store — _Proposed_

**Decision.** All producers emit `atlas.platform.activity-recorded.v1`. PostgreSQL producers write it in
the same transaction as the change (transactional outbox); the gateway uses a durable Valkey list.
audit-service stores it idempotently (event id as key) in a per-tenant SHA-256 hash chain, append-only
at the privilege, trigger and API levels. Before/after values are recorded for allow-listed
non-sensitive fields only.

**Why.** "A change cannot commit without its audit event" (roadmap 1A-8) and no loss during broker
outages. **Change from Stage 0:** the earlier example contract `configuration-changed.v1` carried field
names only; the owner asked for before/after information, so values are now recorded for allow-listed
fields, and the contract rejects credential-like field names. `configuration-changed.v1` remains as an
unused example contract.

### ADR-029 Jaeger as the local trace backend — _Proposed_

**Decision.** `jaegertracing/jaeger:2.22.0` (Apache-2.0) receives OTLP directly; Grafana gets a Jaeger
datasource. **Why:** permissive licence, single container, query API used by an automated trace test.
**Alternative:** Grafana Tempo (AGPL-3.0, more moving parts). Services only speak OTLP, so the backend
is replaceable.

### ADR-030 A second factor is required for platform-wide permissions — _Proposed_

**Decision.** Platform users must enrol TOTP (required at invitation; pre-enrolled for local demo
accounts). The IdP reports the methods used in `amr` (configured AMR references `pwd`/`otp`); the
gateway and every service ignore platform-wide permissions when `amr` lacks a second factor
(`PLATFORM_MFA_REQUIRED`, default true). Issuer users may enrol optionally.

**Amended (security remediation).** Granting platform roles to an existing account (an issuer user
promoted, or an invitation that matches an existing account) now also requires TOTP enrolment at the
identity provider when the account has no second factor, and ends the account's provider sessions, so
the next sign-in goes through enrolment. Until then the account holds no platform permission (the
`amr` rule above), so the promotion fails closed.

### ADR-031 Event contracts may have several producers — _Proposed_

**Decision.** `defineEvent` accepts `producers` (still accepts a single `producer`); publishers must be
listed. Needed because several services emit audit activity. Additive change to `@atlas/contracts`.

### ADR-032 Cross-tenant access returns 404 and is audited on the platform chain — _Proposed_

**Decision.** A user with no access to an issuer gets 404 for any of its resources (403 only inside an
issuer they belong to). The denial is recorded on the platform audit chain with the target issuer in
metadata, not in the target issuer's own trail.

**Why.** Existence is not disclosed, and one issuer's auditors never see another issuer's users.

## Stage 1A security remediation decisions (proposed, for review)

### ADR-033 Stage 1A stores synthetic records only, enforced by the database — _Proposed_

**Decision.** Every issuer and every user is synthetic in Stage 1A, whatever `ATLAS_ENV` says. Services
always write `is_synthetic = true`; `CHECK` constraints (`tenant_stage_1a_synthetic_only`,
`user_account_stage_1a_synthetic_only`) refuse anything else for every role, including the migrator;
user email addresses and issuer support contacts must use reserved domains (RFC 2606 / 6761:
`*.test`, `*.example`, `*.invalid`, `*.localhost`, `example.com/.net/.org`), checked by the contracts and
by constraints that use the same pattern text (`syntheticEmailDomainPattern`).

**Why.** Previously `is_synthetic` followed `ATLAS_ENV`, so a deployment labelled staging or
production would silently have created "real" records with no production controls in place.
**Alternative rejected:** an environment variable or flag that permits real records — one
misconfiguration away from real personal data in a system that is not ready for it.

**How real records will be introduced (future, not Stage 1A).** Only through a reviewed change that
(1) is recorded as a new ADR naming the stage and the environments concerned; (2) ships a migration
that replaces these constraints with a rule tied to a controlled data-classification attribute, rather
than dropping them, together with the controls real data needs — retention and deletion, DPIA and
records of processing, access review, encryption at rest, backup handling and breach procedures
(SECURITY_MODEL.md, "Future requirements"); (3) introduces an explicit, audited operator action for
creating a non-synthetic issuer or user (never a default); and (4) keeps synthetic and real data
separable for reporting and deletion. The synthetic constraints stay in every database used for
development, test and simulation.

### ADR-034 Row-level-security context held by the database, set once per transaction — _Proposed_

**Decision.** `inScope()` declares the tenant context with `<schema>.begin_tenant_context(scope,
tenant_ids)`, a `SECURITY DEFINER` function that records it in `<schema>.tenant_context`, keyed on the
backend and the transaction id, and refuses a second declaration in the same transaction. Policies read
the context through `SECURITY DEFINER` accessors. The service role has no privilege on the table, and the
session settings `atlas.scope` / `atlas.tenant_ids` are no longer read by anything.

**Why.** Any role can change a custom setting with `set_config()`, so the previous design could be
widened by one injected expression inside a tenant-scoped query: it guarded only against forgetting a
tenant predicate. The new context cannot be changed by the statements running inside it and cannot
outlive its transaction on a pooled connection.

**Limits, stated plainly.** Code holding the service's database credentials and able to run its own
transactions (a compromised service process) can still declare platform-wide scope, because the service
legitimately does so for platform administrators, relays and consumers. Closing that needs the database
to verify a credential the service cannot mint, which is not achievable in Stage 1A without changing the
architecture. **Options for production (not chosen yet):** separate deployables (and database roles) for
platform-wide and tenant-scoped work, so a tenant-facing process has no role that can declare `all`;
or a context signed by a component the service does not control (e.g. the gateway) and verified in the
database. **Costs accepted:** every scoped transaction is assigned a transaction id (more xid
consumption, a write to an unlogged table); the context table is not replicated to standbys, so read
replicas would need a different mechanism.

### ADR-035 The database enforces permission scopes and protects system roles — _Proposed_

**Decision.** `@atlas/contracts` remains the only definition of permissions, scopes and system roles.
The migration tool copies it into `identity.permission` and the system roles after every run
(`database/src/catalogue.ts`, audited through the identity outbox). Triggers refuse any role permission
that is unknown, duplicated or not allowed at the role's scope, and any catalogue change that would
leave a role in that state; row-level security on `identity.role` makes system roles read-only for the
service role. identity-service no longer writes system roles at start-up; it verifies that the database
matches the catalogue it was built with and is not ready otherwise.

**Why.** The documentation claimed a database constraint that did not exist; a direct write with the
identity-service credentials could have placed platform-only permissions in an issuer role.
**Alternative rejected:** a hand-maintained SQL list of permissions — a second catalogue that would
drift from the contracts.

### ADR-036 Privilege ceiling and no self-change for platform administration — _Proposed_

**Decision.** A caller may grant or remove platform roles, change the status of a platform user, or
create or change a role only within the permissions they hold platform-wide themselves; nobody may
change a role they hold; "inviting" one's own email address is treated as changing one's own roles and
refused. Refusals are audited (`access.denied`, reason `privilege-ceiling` or `self-change`).

**Why.** Without it, any holder of `platform.users.manage` (for example a narrow custom role) could
make a second account Platform Super Admin, and any holder of `platform.roles.manage` could add
permissions to a role they hold. Platform Super Admins are unaffected. **Not applied to issuer roles:**
issuer user managers assign any issuer role within their issuer by design (ADR-026); they still cannot
change their own roles.
