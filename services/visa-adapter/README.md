# Visa Adapter (`visa-adapter`)

> **Stage 0 status:** skeleton only — infrastructure endpoints, no domain logic.

## Responsibilities

- Visa Secure specific message extensions, field rules and behaviour.
- Connectivity to the Visa directory server (future, subject to scheme onboarding).
- Translates between scheme specifics and ATLAS-internal contracts.

## Does not own

Mastercard behaviour, transaction state, or authentication decisions. Implemented greenfield; no proprietary scheme code.

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
pnpm --filter @atlas/visa-adapter dev     # watch mode, reads ../../.env
pnpm --filter @atlas/visa-adapter build && pnpm --filter @atlas/visa-adapter start
```
