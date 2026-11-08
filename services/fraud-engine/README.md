# Fraud Engine (`fraud-engine`)

> **Stage 0 status:** skeleton only — infrastructure endpoints, no domain logic.

## Responsibilities

- Issuer-configurable risk rules (schema `fraud`).
- Synchronous risk assessment for ACS Core on the authentication path.

## Does not own

The final authentication decision, which ACS Core makes from risk and compliance inputs.

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
pnpm --filter @atlas/fraud-engine dev     # watch mode, reads ../../.env
pnpm --filter @atlas/fraud-engine build && pnpm --filter @atlas/fraud-engine start
```
