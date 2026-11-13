# API Gateway (`api-gateway`)

> **Stage 1A status:** implemented — portal backend-for-frontend: OIDC sign-in (code + PKCE), encrypted
> Valkey sessions, refresh, CSRF, rate limiting (Valkey, with fallback), audited sign-in/out, forwarding
> to services with per-callee service tokens. Routes: `packages/contracts/src/http/v1/session.ts`.

## Responsibilities

- Single entry point for the portal and, later, external callers.
- CORS, rate limiting and secure headers at the edge.
- Aggregates platform service health for the portal (implemented in Stage 0).
- Future: authentication of portal sessions, request routing to owning services.

## Does not own

Business logic of any kind. The gateway routes and protects; it does not decide.

## Infrastructure dependencies

none. Connection URLs are required configuration when declared; see [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md).

## Endpoints

| Path                        | Purpose                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `GET /health/live`          | Liveness: the process is running.                                          |
| `GET /health/ready`         | Readiness: dependencies reachable; `503` while not ready or shutting down. |
| `GET /info`                 | Service metadata (name, version, environment, API versions, build).        |
| `GET /metrics`              | Prometheus metrics.                                                        |
| `GET /v1/platform/services` | Aggregated readiness of all registered services.                           |

## Running

```bash
pnpm --filter @atlas/api-gateway dev     # watch mode, reads ../../.env
pnpm --filter @atlas/api-gateway build && pnpm --filter @atlas/api-gateway start
```
