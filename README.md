# ATLAS ACS

ATLAS is an independent, extensible **EMV® 3-D Secure Access Control Server (ACS)** platform, built to
demonstrate issuer-side 3DS authentication for Visa Secure and Mastercard Identity Check against a
working local simulation environment.

> **Status: Stage 0 — platform foundation.** The services, contracts, infrastructure, portal shell
> and quality gates exist and run. **No 3DS protocol processing, risk decisioning, challenge flows
> or scheme connectivity exist yet.** ATLAS is not production software, has not been assessed
> against PCI DSS or any scheme programme, and must only be used with synthetic data.

## Quick start

Prerequisites: Node.js 24 LTS, pnpm 12, Docker with Compose v2.

```bash
pnpm install
pnpm setup:env          # creates .env with generated local-only credentials
pnpm infra:up           # PostgreSQL, Valkey, RabbitMQ, Mailpit, Prometheus, Grafana
pnpm db:migrate && pnpm db:seed
pnpm dev:services       # all 13 services in watch mode (separate terminal)
pnpm dev:portal         # http://localhost:5173
```

Or run everything in containers: `pnpm stack:up` (portal at http://localhost:8080).

Full instructions, ports and troubleshooting: **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

## Repository layout

| Path             | Contents                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `apps/portal`    | Combined React portal for platform administrators and issuer users                             |
| `services/*`     | 13 independently deployable Fastify services                                                   |
| `packages/*`     | Shared libraries: `contracts`, `schemas`, `security`, `observability`, `shared`, `service-kit` |
| `database`       | Versioned SQL migrations (per owning service), development seeds, tooling                      |
| `infrastructure` | Dockerfiles, Prometheus/Grafana configuration, deployment notes                                |
| `simulator`      | Reserved for the 3DS Server / Directory Server simulator (Stage 1B)                            |
| `tests`          | Cross-service suites: `integration`, `smoke`, `e2e`, `protocol`, `compliance`                  |
| `docs`           | Architecture, security, compliance, protocol, roadmap and decision records                     |

## Documentation

- [Project overview](docs/PROJECT_OVERVIEW.md) · [Roadmap](docs/roadmap/ROADMAP.md) · [Decisions](docs/decisions/DECISIONS.md)
- [Architecture](docs/architecture/ARCHITECTURE.md) · [Conventions](docs/architecture/CONVENTIONS.md) · [Data model](docs/architecture/DATA_MODEL.md)
- [Security model](docs/security/SECURITY_MODEL.md) · [Compliance matrix](docs/compliance/COMPLIANCE_MATRIX.md) · [Protocol support](docs/protocol/PROTOCOL_SUPPORT.md)
- [Development](docs/DEVELOPMENT.md) · [Migration strategy](docs/MIGRATION_STRATEGY.md)

## Common commands

| Command                                                                      | Purpose                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `pnpm check`                                                                 | Format check, lint, type-check, unit tests, build |
| `pnpm test` / `test:smoke` / `test:integration` / `test:e2e`                 | Test suites (see DEVELOPMENT.md)                  |
| `pnpm db:migrate` / `db:rollback --owner <schema>` / `db:status` / `db:seed` | Database tooling                                  |
| `pnpm infra:up` / `infra:down` / `stack:up` / `stack:down`                   | Docker Compose environment                        |

EMV® is a registered trademark of EMVCo, LLC. Visa Secure and Mastercard Identity Check are trademarks of
their respective owners. ATLAS is not affiliated with, endorsed by or certified by EMVCo, Visa or
Mastercard.
