# Development guide

Everything needed to run ATLAS locally from a fresh clone. No external accounts, employer access or
production credentials are required.

## Prerequisites

| Tool    | Version                            | Check                                            |
| ------- | ---------------------------------- | ------------------------------------------------ |
| Node.js | 24 LTS (see `.nvmrc`)              | `node -v`                                        |
| pnpm    | 12.16.1 (pinned in `package.json`) | `pnpm -v` — install with `npm i -g pnpm@12.16.1` |
| Docker  | Engine 24+ with Compose v2         | `docker compose version`                         |

Resources: core infrastructure needs ~1.5 GB RAM; the full container stack ~4 GB; with Keycloak ~5 GB.

## GitHub Codespaces

The repository includes a dev container ([`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json)).
A new or rebuilt Codespace comes with Node 24, Docker, pnpm 12.16.1, installed dependencies and a
generated `.env`. Then:

```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed   # or: pnpm stack:up
```

Ports for the portal (8080, 5173), gateway (4000), Grafana (3000), Prometheus (9090), RabbitMQ management
(15672), Mailpit (8025) and Keycloak (8180) are forwarded and labelled in the **Ports** panel. Forwarded
URLs look like `https://<codespace-name>-<port>.app.github.dev` and are private to your GitHub account.
Data-store and broker ports are deliberately not forwarded. Allow at least 8 GB RAM: the full stack with
Keycloak uses about 5 GB.

Containers use `restart: unless-stopped`, so a running stack comes back by itself after the Codespace
restarts. Stop it with `pnpm stack:down` or `pnpm infra:down` when you don't need it. To reclaim disk
space after image rebuilds, run `docker builder prune -a -f`; never prune volumes, which hold local data.

Existing Codespaces pick up the configuration only after **Codespaces: Rebuild Container**. If a port is
missing from the Ports panel, use **Forward a Port** and enter its number.

## First-time setup

```bash
git clone <repository-url> atlas-acs && cd atlas-acs
pnpm install                 # dependency build scripts are denied unless allow-listed
pnpm setup:env               # creates .env (mode 600) with generated local-only passwords
pnpm infra:up                # starts infrastructure and waits until healthy
pnpm db:migrate              # applies all owners' migrations
pnpm db:seed                 # loads synthetic development data
```

`.env` is git-ignored. To regenerate credentials: `pnpm infra:down`, `docker compose down -v` (deletes
local data), delete `.env`, run `pnpm setup:env` again.

## Running

### Option A — services on the host (fast iteration)

```bash
pnpm dev:services            # all 13 services, watch mode, reading ../../.env
pnpm dev:portal              # http://localhost:5173 (proxies /api to the gateway on :4000)
```

Run a single service: `pnpm --filter @atlas/acs-core dev`.

### Option B — everything in containers

```bash
pnpm stack:up                # builds images, runs migrations, starts services and portal
open http://localhost:8080   # portal (nginx, proxying /api to the gateway)
pnpm stack:down
```

The first build takes several minutes; subsequent builds reuse the shared build stage.

### Optional: Keycloak

```bash
docker compose --profile identity up -d --wait keycloak
```

Admin console at http://localhost:8180 (credentials in `.env`). The `atlas` realm is imported with the
`atlas-portal` client and roles; no users are pre-created. Portal sign-in arrives in Stage 1A.

## Local ports and URLs

All ports bind to `127.0.0.1`.

| Port        | Component                                                                                                                                                                                       | URL / notes                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 5173        | Portal (Vite dev server)                                                                                                                                                                        | http://localhost:5173                                        |
| 8080        | Portal (container, nginx)                                                                                                                                                                       | http://localhost:8080                                        |
| 4000        | api-gateway                                                                                                                                                                                     | http://localhost:4000/v1/platform/services                   |
| 4001–4012   | acs-core, protocol, visa-adapter, mastercard-adapter, fraud-engine, compliance-engine, challenge-engine, issuer-service, cardholder-service, identity-service, reporting-service, audit-service | `/health/live`, `/health/ready`, `/info`, `/metrics`         |
| 5432        | PostgreSQL                                                                                                                                                                                      | `DATABASE_URL` in `.env`                                     |
| 6379        | Valkey                                                                                                                                                                                          | `VALKEY_URL` in `.env`                                       |
| 5672        | RabbitMQ (AMQP)                                                                                                                                                                                 | `RABBITMQ_URL` in `.env`                                     |
| 15672       | RabbitMQ management                                                                                                                                                                             | http://localhost:15672 (user/password in `.env`)             |
| 1025 / 8025 | Mailpit SMTP / UI                                                                                                                                                                               | http://localhost:8025                                        |
| 9090        | Prometheus                                                                                                                                                                                      | http://localhost:9090/targets                                |
| 3000        | Grafana                                                                                                                                                                                         | http://localhost:3000 — dashboard _ATLAS → Service Overview_ |
| 8180        | Keycloak (optional)                                                                                                                                                                             | http://localhost:8180                                        |

Prometheus scrapes services both as containers (`atlas-services` job) and as host processes
(`atlas-services-host`); whichever mode is not in use shows as down.

## Quality checks

| Command                 | What it runs                                                                                                                       | Needs                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `pnpm check`            | Prettier check, ESLint, type-check, unit tests, build                                                                              | —                                                      |
| `pnpm test`             | Unit tests (packages, services, portal, database tooling)                                                                          | —                                                      |
| `pnpm test:smoke`       | Starts each **built** service as a process; health, metrics, SIGTERM shutdown; invalid-config refusal                              | `pnpm build`                                           |
| `pnpm test:integration` | PostgreSQL (incl. migrations up/down/up in a throwaway database), Valkey, RabbitMQ messaging and dead-lettering, service readiness | `pnpm infra:up` and `.env`                             |
| `pnpm test:e2e`         | Playwright against a portal production build (desktop and tablet)                                                                  | `pnpm --filter @atlas/e2e-tests install-browsers` once |
| `pnpm audit:deps`       | Dependency advisories (fails on high/critical)                                                                                     | network                                                |
| `pnpm format`           | Apply Prettier formatting                                                                                                          | —                                                      |

CI runs all of these on pull requests and pushes to `main` (`.github/workflows/ci.yml`).

## Database workflow

```bash
pnpm db:status                              # applied / pending per owner
pnpm db:migrate                             # apply pending migrations for all owners
pnpm db:rollback --owner issuer             # revert the latest issuer migration
pnpm db:rollback --owner issuer --count 2
```

Adding a migration: create `database/migrations/<schema>/<UTC yyyymmddhhmmss>_<kebab-name>.sql` with
`-- Up Migration` and `-- Down Migration` sections. The schema must belong to a service in the catalogue.
See [DATA_MODEL.md](architecture/DATA_MODEL.md#managing-database-changes).

## Adding a service

1. Add the service to the catalogue in `packages/contracts/src/services.ts` (name, port, domain, owned
   data stores).
2. Copy an existing skeleton under `services/` and change the name and dependencies in `src/service.ts`.
3. Add it to `compose.yaml`, `infrastructure/monitoring/prometheus/prometheus.yml` and, if it has a
   database schema, create `database/migrations/<schema>/`.
4. `pnpm install`, `pnpm check`, `pnpm test:smoke`.

## Troubleshooting

| Symptom                                                             | Cause / fix                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `required variable VALKEY_PASSWORD is missing` with an older `.env` | Redis was replaced by Valkey (ADR-019): rename `REDIS_PASSWORD` → `VALKEY_PASSWORD` and `REDIS_URL` → `VALKEY_URL` in `.env` |
| `required variable POSTGRES_PASSWORD is missing` from Compose       | Run `pnpm setup:env`                                                                                                         |
| A service exits immediately with `invalid configuration`            | The JSON line names the keys; check `.env` or the variables passed                                                           |
| `/health/ready` returns 503                                         | `checks` shows which dependency is down; `pnpm infra:up`                                                                     |
| `ERR_PNPM_IGNORED_BUILDS` on install                                | A new dependency wants an install script; review it, then add it to `allowBuilds` in `pnpm-workspace.yaml` only if necessary |
| pnpm refuses a just-published package                               | Minimum release-age policy; wait or choose an older version                                                                  |
| Port already in use                                                 | Stop the conflicting process, or change the host port mapping in `compose.yaml`                                              |
| Smoke tests fail with "run pnpm build"                              | Build first: `pnpm build`                                                                                                    |
| Portal shows "API gateway could not be reached"                     | Start the gateway (`pnpm dev:services` or `pnpm stack:up`)                                                                   |
