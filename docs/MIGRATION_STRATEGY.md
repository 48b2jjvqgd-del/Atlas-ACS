# Migration strategy

How ATLAS stays portable from this independent repository into a future company-controlled environment.

> **Nothing in this document authorises a migration.** Moving ATLAS, or any part of it, into a company
> environment requires the approvals listed in [Approval requirements](#approval-requirements) first.

## Guiding rule

Everything environment-specific is **configuration**, injected at deploy time. The source code contains
no hostnames, credentials, cloud SDKs, employer libraries or employer conventions. A migration therefore
replaces configuration and infrastructure, not code.

## Source code portability

| Aspect             | Current state                                                                    | On migration                                                                                  |
| ------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Repository         | Single git monorepo, conventional history                                        | Import with full history, or as a squashed snapshot if required by policy                     |
| Toolchain          | Node.js 24 LTS, pnpm 12 (pinned via `packageManager`), TypeScript 6              | Mirror the npm registry through the company proxy (`.npmrc` registry setting); no code change |
| Dependencies       | Public npm packages, exact versions in `pnpm-lock.yaml`                          | Re-resolve through the company registry; review via the licence register below                |
| Build              | `pnpm build`; per-service images from one Dockerfile                             | Run in company CI; base images from the company registry via `NODE_IMAGE` build argument      |
| CI                 | GitHub Actions (`.github/workflows/ci.yml`) — plain `pnpm` and `docker` commands | Port to the company CI system; each job is a few shell commands                               |
| Ownership metadata | Personal repository URL in the image source label                                | Update label and package metadata                                                             |

## Infrastructure portability

| Component     | Local              | Interface the code depends on                                   | Company replacement                                                                                                   |
| ------------- | ------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL    | Container          | PostgreSQL wire protocol, `DATABASE_URL`                        | Managed or company-operated PostgreSQL 15+ (uses `gen_random_uuid()` and standard SQL only)                           |
| Valkey        | Container          | Redis protocol (RESP), `VALKEY_URL`                             | Company Valkey, or any Redis-protocol-compatible managed cache                                                        |
| RabbitMQ      | Container          | AMQP 0-9-1, `RABBITMQ_URL`; quorum queues                       | Company RabbitMQ; or another broker by replacing `messaging.ts` — events are CloudEvents, so their shape is preserved |
| Identity      | Keycloak container | OpenID Connect discovery (Stage 1A)                             | Company IdP via OIDC issuer URL and client registration                                                               |
| Metrics       | Prometheus/Grafana | Prometheus exposition at `/metrics`                             | Any Prometheus-compatible collector                                                                                   |
| Tracing       | None by default    | OTLP/HTTP, `OTEL_EXPORTER_OTLP_ENDPOINT`                        | Company OpenTelemetry collector or APM with OTLP ingest                                                               |
| Logs          | stdout JSON        | stdout                                                          | Company log shipping (no code change)                                                                                 |
| Email         | Mailpit            | SMTP (Stage 3)                                                  | Company mail relay                                                                                                    |
| Orchestration | Docker Compose     | Container image + env vars + `/health/live` and `/health/ready` | Kubernetes, ECS, Nomad or VMs; probes map directly                                                                    |

No component depends on a particular cloud provider.

## Environment configuration

- Every setting is an environment variable documented in [`.env.example`](../.env.example) and
  [CONVENTIONS.md](architecture/CONVENTIONS.md#configuration).
- Configuration is validated at startup; a misconfigured service refuses to start and names the keys.
- `ATLAS_ENV` must be set explicitly (`staging`/`production` disable synthetic seeding).
- Compose files are local-development artefacts; a company environment uses its own deployment
  descriptors in `infrastructure/deployment/<target>/`.

## Secrets replacement

| Secret                                 | Local source                                                      | Company replacement                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Database, Valkey, RabbitMQ credentials | Generated into `.env` by `pnpm setup:env`                         | Secret manager, mounted as files: `DATABASE_URL_FILE`, `VALKEY_URL_FILE`, `RABBITMQ_URL_FILE`, `MIGRATION_DATABASE_URL_FILE` |
| Grafana / Keycloak admin passwords     | `.env`                                                            | Not migrated — company tools replace them                                                                                    |
| OIDC client configuration (Stage 1A)   | Keycloak realm import                                             | Company IdP registration                                                                                                     |
| Service-to-service credentials         | Local Keycloak client-credentials tokens, implemented in Stage 1A | Company PKI and token issuer, integrated in Stage 7                                                                          |
| Cryptographic keys (Stage 1B+)         | Software keys, **simulation only**                                | HSM-held keys, generated in the target environment. **No key material ever moves from the independent environment.**         |

All local credentials are disposable; none are reused anywhere else.

## Database migration

- Schema is reproduced from versioned migrations: `migrate up` against an empty database recreates every
  owner's schema exactly.
- **Data is not migrated.** The independent environment contains synthetic data only; seeds are refused
  outside development/test/simulation.
- Migrations can run under company change control as a separate job with a privileged role; runtime
  services use least-privilege roles per schema.
- If company policy mandates Flyway or Liquibase, the SQL files can be adopted directly (each owner's
  directory maps to a separate history table/schema).
- Each owner schema can be placed in its own database if required by isolation policy (ADR-012).

## External integration replacement

| Integration                                            | Independent environment                        | Company environment                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Visa / Mastercard directory servers                    | ATLAS simulator (Stage 1B+)                    | Scheme test, then production DS endpoints via the adapters' configuration, with company-held certificates |
| HSM                                                    | Software provider (simulation only, Stage 1B+) | Company HSM via the provider interface (Stage 7)                                                          |
| OTP / out-of-band delivery                             | Mailpit, simulated SMS/app                     | Company or contracted delivery providers via provider interfaces                                          |
| Issuer systems (card data, cardholder contact details) | Synthetic data                                 | Company integrations, designed with data-protection review                                                |

Simulated implementations sit behind the same interfaces as real ones, selected by configuration.

## Dependency and licence review

Production npm dependencies (174 packages, `pnpm -r licenses list --prod`, Stage 0):

| Licence       | Count | Notes                                                                  |
| ------------- | ----- | ---------------------------------------------------------------------- |
| MIT           | 111   | Permissive                                                             |
| Apache-2.0    | 34    | Permissive; includes OpenTelemetry, `@prometheus-io/client`            |
| BSD-3-Clause  | 13    | Permissive (protobufjs, light-my-request, secure-json-parse, fast-uri) |
| ISC           | 11    | Permissive                                                             |
| BlueOak-1.0.0 | 5     | Permissive (glob, minimatch family)                                    |

Build/development-only: MPL-2.0 (`lightningcss`, used by Tailwind at build time; not shipped) and
CC-BY-4.0 (`caniuse-lite` browser data; attribution licence, build time only).

Infrastructure images (not linked into ATLAS code; run as separate processes):

| Component                  | Licence            | Review note                                                                      |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| PostgreSQL                 | PostgreSQL Licence | Permissive                                                                       |
| Valkey 9                   | BSD-3-Clause       | Permissive — adopted in place of Valkey 8 (AGPLv3/RSALv2/SSPLv1), ADR-019        |
| RabbitMQ                   | MPL-2.0            | Weak copyleft; unmodified use                                                    |
| Keycloak                   | Apache-2.0         | Permissive                                                                       |
| Prometheus                 | Apache-2.0         | Permissive                                                                       |
| Grafana OSS                | AGPLv3             | **Review** — unmodified separate tool; company may substitute its own dashboards |
| Mailpit                    | MIT                | Local development only                                                           |
| nginx (unprivileged image) | BSD-2-Clause       | Permissive                                                                       |
| Node.js                    | MIT                | Permissive                                                                       |

Before migration: regenerate this register, run a full SCA scan with the company's tooling, and
resolve every item marked **Review**.

## Security review

Before any code enters a company environment:

1. Repository scan for secrets (history included) — expected clean; `.env` has never been committed.
2. SAST and dependency/container scanning with company tools; remediate per company policy.
3. Review against the company's secure-development standards; record deviations.
4. Threat-model review of the architecture and the stage reached.
5. Confirm no employer, customer or cardholder data, and no scheme-confidential material, is present.
6. PCI DSS / PCI 3DS scoping with the company's QSA before any connection to card data or schemes.

## Approval requirements

| Approval                                                            | Typical approver           | Required before                      |
| ------------------------------------------------------------------- | -------------------------- | ------------------------------------ |
| Intellectual property and ownership of independently developed code | Legal / IP                 | Any transfer                         |
| Open-source licence compliance (register above)                     | Legal / OSPO               | Any transfer                         |
| Information security review                                         | Security                   | Code enters company network          |
| Architecture review and fit with company standards                  | Architecture board         | Integration work                     |
| Data protection (DPIA)                                              | DPO / Privacy              | Any personal data processing         |
| PCI scoping                                                         | Compliance / QSA           | Any card data or scheme connectivity |
| Scheme programme participation                                      | Scheme relationship owners | Scheme test connectivity             |
| Change management for deployment                                    | Operations / CAB           | First deployment                     |

Until these are obtained, ATLAS remains an independent project and must not be connected to company
systems, data or credentials.
