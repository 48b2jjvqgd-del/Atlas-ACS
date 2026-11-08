# Challenge Engine (`challenge-engine`)

> **Stage 0 status:** skeleton only — infrastructure endpoints, no domain logic.

## Responsibilities

- Cardholder challenge sessions (schema `challenge`, Valkey prefix `atlas:challenge-engine:`).
- Orchestration of authentication methods (OTP, out-of-band, biometrics) via pluggable providers.

## Does not own

Cardholder enrolment data (cardholder-service) or delivery infrastructure.

## Infrastructure dependencies

`postgres`, `valkey`. Connection URLs are required configuration when declared; see [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md).

## Endpoints

| Path                | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `GET /health/live`  | Liveness: the process is running.                                          |
| `GET /health/ready` | Readiness: dependencies reachable; `503` while not ready or shutting down. |
| `GET /info`         | Service metadata (name, version, environment, API versions, build).        |
| `GET /metrics`      | Prometheus metrics.                                                        |

## Running

```bash
pnpm --filter @atlas/challenge-engine dev     # watch mode, reads ../../.env
pnpm --filter @atlas/challenge-engine build && pnpm --filter @atlas/challenge-engine start
```
