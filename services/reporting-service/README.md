# Reporting Service (`reporting-service`)

> **Stage 0 status:** skeleton only — infrastructure endpoints, no domain logic.

## Responsibilities

- Read-optimised projections built by consuming platform events (schema `reporting`).
- Tenant-scoped reports for issuers; cross-tenant reports for platform administrators.

## Does not own

Any source-of-truth data. Reporting never writes to another service’s schema.

## Infrastructure dependencies

`postgres`, `rabbitmq`. Connection URLs are required configuration when declared; see [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md).

## Endpoints

| Path                | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `GET /health/live`  | Liveness: the process is running.                                          |
| `GET /health/ready` | Readiness: dependencies reachable; `503` while not ready or shutting down. |
| `GET /info`         | Service metadata (name, version, environment, API versions, build).        |
| `GET /metrics`      | Prometheus metrics.                                                        |

## Running

```bash
pnpm --filter @atlas/reporting-service dev     # watch mode, reads ../../.env
pnpm --filter @atlas/reporting-service build && pnpm --filter @atlas/reporting-service start
```
