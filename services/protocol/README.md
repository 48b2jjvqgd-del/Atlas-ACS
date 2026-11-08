# Protocol Service (`protocol`)

> **Stage 0 status:** skeleton only — infrastructure endpoints, no domain logic.

## Responsibilities

- Parsing and validation of EMV 3DS messages (AReq/ARes, CReq/CRes, RReq/RRes, Erro).
- Protocol version negotiation and message-version support matrix.
- Stateless: holds no persistent data.

## Does not own

Transaction state or authentication decisions.

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
pnpm --filter @atlas/protocol dev     # watch mode, reads ../../.env
pnpm --filter @atlas/protocol build && pnpm --filter @atlas/protocol start
```
