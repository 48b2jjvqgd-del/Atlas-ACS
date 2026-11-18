# Audit Service (`audit-service`)

> **Stage 1A status:** implemented — consumes `atlas.platform.activity-recorded.v1` (retry, dead-letter,
> idempotent), stores an append-only SHA-256 hash chain per issuer plus a platform chain, serves the
> trail (platform and per issuer) and chain verification. Routes: `packages/contracts/src/http/v1/audit.ts`.

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
