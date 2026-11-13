# Issuer Service (`issuer-service`)

> **Stage 1A status:** implemented — issuer registry (`/v1/tenants`), lifecycle transitions, versioned
> configuration with optimistic concurrency, internal tenant lookup for identity-service; audited through
> the transactional outbox; row-level security. Routes and permissions: `packages/contracts/src/http/v1/issuer.ts`.

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
