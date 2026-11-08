# Compliance Engine (`compliance-engine`)

> **Stage 0 status:** skeleton only — infrastructure endpoints, no domain logic.

## Responsibilities

- Evaluation of regulatory and scheme requirements, e.g. PSD2 SCA exemptions (schema `compliance`).
- Synchronous compliance evaluation for ACS Core.

## Does not own

Fraud scoring or the final decision.

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
pnpm --filter @atlas/compliance-engine dev     # watch mode, reads ../../.env
pnpm --filter @atlas/compliance-engine build && pnpm --filter @atlas/compliance-engine start
```
