# Cardholder Service (`cardholder-service`)

> **Stage 0 status:** skeleton only — infrastructure endpoints, no domain logic.

## Responsibilities

- Cardholder enrolment and registered authentication methods (schema `cardholder`).
- Tenant-scoped: every record belongs to exactly one issuer.

## Does not own

Full PANs in clear text. Card data storage will require tokenisation/encryption design approval before any cardholder data is stored.

## Infrastructure dependencies

`postgres`. Connection URLs are required configuration when declared; see [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md).

## Endpoints

| Path                | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `GET /health/live`  | Liveness: the process is running.                                          |
| `GET /health/ready` | Readiness: dependencies reachable; `503` while not ready or shutting down. |
| `GET /info`         | Service metadata (name, version, environment, API versions, build).        |
| `GET /metrics`      | Prometheus metrics.                                                        |

## Running

```bash
pnpm --filter @atlas/cardholder-service dev     # watch mode, reads ../../.env
pnpm --filter @atlas/cardholder-service build && pnpm --filter @atlas/cardholder-service start
```
