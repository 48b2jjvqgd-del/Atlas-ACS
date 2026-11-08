# Audit Service (`audit-service`)

> **Stage 0 status:** skeleton only — infrastructure endpoints, no domain logic.

## Responsibilities

- Append-only, tamper-evident audit trail (schema `audit`).
- Consumes configuration-change and decision events from every service.

## Does not own

The audited data itself — it records who changed what, when and why.

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
pnpm --filter @atlas/audit-service dev     # watch mode, reads ../../.env
pnpm --filter @atlas/audit-service build && pnpm --filter @atlas/audit-service start
```
