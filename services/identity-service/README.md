# Identity Service (`identity-service`)

> **Stage 1A status:** implemented — users, roles (system and custom), permissions and issuer
> memberships; principal resolution for other services; Keycloak user provisioning and invitations;
> failed sign-in ingestion; escalation guards. Routes: `packages/contracts/src/http/v1/identity.ts`.

## Responsibilities

- Portal identities, roles and granular permissions (schema `identity`).
- Integration with an external OpenID Connect provider (Keycloak locally).
- Source of the permission set used for permission-driven portal navigation.

## Does not own

Cardholder authentication, which is the challenge-engine domain.

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
pnpm --filter @atlas/identity-service dev     # watch mode, reads ../../.env
pnpm --filter @atlas/identity-service build && pnpm --filter @atlas/identity-service start
```
