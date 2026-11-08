# Issuer Service (`issuer-service`)

> **Stage 0 status:** skeleton only — infrastructure endpoints, no domain logic.

## Responsibilities

- Issuer (tenant) registry: the system of record for tenants (schema `issuer`).
- Issuer configuration: BIN ranges, scheme participation, branding (future).
- Publishes tenant and configuration-change events.

## Does not own

Users and permissions (identity-service) or cardholders (cardholder-service).

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
pnpm --filter @atlas/issuer-service dev     # watch mode, reads ../../.env
pnpm --filter @atlas/issuer-service build && pnpm --filter @atlas/issuer-service start
```
