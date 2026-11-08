# ACS Core (`acs-core`)

> **Stage 0 status:** skeleton only — infrastructure endpoints, no domain logic.

## Responsibilities

- Orchestrates the EMV 3DS authentication transaction lifecycle.
- Calls protocol, fraud-engine, compliance-engine and challenge-engine synchronously on the authentication path.
- Owns authentication transaction state (PostgreSQL schema `acs`, Valkey prefix `atlas:acs-core:`).
- Publishes authentication outcome events for audit and reporting.

## Does not own

Scheme-specific behaviour (delegated to the scheme adapters) and risk rules (fraud-engine). ACS Core must remain scheme-agnostic.

## Infrastructure dependencies

`postgres`, `valkey`, `rabbitmq`. Connection URLs are required configuration when declared; see [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md).

## Endpoints

| Path                | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `GET /health/live`  | Liveness: the process is running.                                          |
| `GET /health/ready` | Readiness: dependencies reachable; `503` while not ready or shutting down. |
| `GET /info`         | Service metadata (name, version, environment, API versions, build).        |
| `GET /metrics`      | Prometheus metrics.                                                        |

## Running

```bash
pnpm --filter @atlas/acs-core dev     # watch mode, reads ../../.env
pnpm --filter @atlas/acs-core build && pnpm --filter @atlas/acs-core start
```
