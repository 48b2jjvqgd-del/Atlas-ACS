# Mastercard Adapter (`mastercard-adapter`)

> **Stage 0 status:** skeleton only — infrastructure endpoints, no domain logic.

## Responsibilities

- Mastercard Identity Check specific message extensions, field rules and behaviour.
- Connectivity to the Mastercard directory server (future, subject to scheme onboarding).
- Translates between scheme specifics and ATLAS-internal contracts.

## Does not own

Visa behaviour, transaction state, or authentication decisions. Implemented greenfield; no proprietary scheme code.

## Infrastructure dependencies

none. Connection URLs are required configuration when declared; see [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md).

## Endpoints

| Path                | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `GET /health/live`  | Liveness: the process is running.                                          |
| `GET /health/ready` | Readiness: dependencies reachable; `503` while not ready or shutting down. |
| `GET /info`         | Service metadata (name, version, environment, API versions, build).        |
| `GET /metrics`      | Prometheus metrics.                                                        |

## Running

```bash
pnpm --filter @atlas/mastercard-adapter dev     # watch mode, reads ../../.env
pnpm --filter @atlas/mastercard-adapter build && pnpm --filter @atlas/mastercard-adapter start
```
