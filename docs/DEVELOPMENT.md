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
pnpm stack:up && pnpm db:seed   # full stack in containers, then synthetic data
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
pnpm setup:env               # creates .env (mode 600) with generated local-only secrets
pnpm stack:up                # Keycloak, Jaeger, migrations (incl. database roles), services, portal
pnpm db:seed                 # synthetic issuers and users
pnpm demo:credentials        # the demo password and the current one-time code
open http://localhost:8080
```

`.env` is git-ignored. **Upgrading from Stage 0:** run `pnpm setup:env` again — it keeps your existing
values and appends the new Stage 1A keys — then `pnpm identity:reset` (re-imports the Keycloak realm,
which now has users and clients) and `pnpm stack:up`. The `migrate` job provisions the per-service
database roles and hands the existing schemas to `atlas_migrator`.

## Signing in (synthetic demo accounts)

Every account uses the password printed by `pnpm demo:credentials`. Platform accounts also need the
one-time code it prints (an authenticator app can be enrolled instead from _Account and security_).

| Account                                                                                                  | Role                             | Sees                                                        |
| -------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `super.admin@atlas.test`                                                                                 | Platform Super Admin             | everything, including platform users and roles              |
| `platform.admin@atlas.test`                                                                              | Platform Administrator           | issuer registry, issuer users, audit, health                |
| `tech.admin@atlas.test`                                                                                  | Technical Administrator          | health, audit (incl. chain verification), read-only issuers |
| `admin@northstar.test` / `admin@meridian.test`                                                           | Issuer Administrator             | their own issuer only                                       |
| `fraud.manager@`, `fraud.analyst@`, `compliance@`, `operations@`, `support@`, `reporting@northstar.test` | one issuer role each             | per role                                                    |
| `support@meridian.test`, `reporting@meridian.test`                                                       | Customer Support, Reporting User | Meridian only                                               |

Invitations sent from the portal arrive in Mailpit (http://localhost:8025).

`pnpm identity:reset` recreates the local Keycloak database from `atlas-realm.json` (synthetic identity
data only; ATLAS data is untouched).

## Running

### Option A — services on the host (fast iteration)

```bash
pnpm infra:up                                  # PostgreSQL, Valkey, RabbitMQ, ...
docker compose --profile identity up -d --wait # Keycloak
pnpm db:provision && pnpm db:migrate && pnpm db:seed
pnpm dev:services            # all 13 services, watch mode, reading ../../.env
pnpm dev:portal              # http://localhost:5173 (proxies /api to the gateway on :4000)
```

Each host-run service picks its own database URL (`<SERVICE>_DATABASE_URL`) and client secret
(`<SERVICE>_SERVICE_CLIENT_SECRET`) from `.env`. For traces, add
`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` and `docker compose --profile tracing up -d jaeger`.

Run a single service: `pnpm --filter @atlas/acs-core dev`.

### Option B — everything in containers

```bash
pnpm stack:up                # builds images, runs migrations, starts services and portal
open http://localhost:8080   # portal (nginx, proxying /api to the gateway)
pnpm stack:down
```

The first build takes several minutes; subsequent builds reuse the shared build stage.

### Keycloak

Part of the stack since Stage 1A. Admin console at http://localhost:8180 (admin credentials in `.env`).
The `atlas` realm holds the gateway client, one client per calling service, audience scopes and the
synthetic users. All secrets in the realm file are `${ENV}` placeholders resolved at import.

## Local ports and URLs

All ports bind to `127.0.0.1`.

| Port        | Component                                                                                                                                                                                       | URL / notes                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 5173        | Portal (Vite dev server)                                                                                                                                                                        | http://localhost:5173                                                |
| 8080        | Portal (container, nginx)                                                                                                                                                                       | http://localhost:8080                                                |
| 4000        | api-gateway                                                                                                                                                                                     | http://localhost:4000/v1/platform/services                           |
| 4001–4012   | acs-core, protocol, visa-adapter, mastercard-adapter, fraud-engine, compliance-engine, challenge-engine, issuer-service, cardholder-service, identity-service, reporting-service, audit-service | `/health/live`, `/health/ready`, `/info`, `/metrics`                 |
| 5432        | PostgreSQL                                                                                                                                                                                      | `DATABASE_URL` in `.env`                                             |
| 6379        | Valkey                                                                                                                                                                                          | `VALKEY_URL` in `.env`                                               |
| 5672        | RabbitMQ (AMQP)                                                                                                                                                                                 | `RABBITMQ_URL` in `.env`                                             |
| 15672       | RabbitMQ management                                                                                                                                                                             | http://localhost:15672 (user/password in `.env`)                     |
| 1025 / 8025 | Mailpit SMTP / UI                                                                                                                                                                               | http://localhost:8025                                                |
| 9090        | Prometheus                                                                                                                                                                                      | http://localhost:9090/targets                                        |
| 3000        | Grafana                                                                                                                                                                                         | http://localhost:3000 — dashboard _ATLAS → Service Overview_         |
| 8180        | Keycloak                                                                                                                                                                                        | http://localhost:8180                                                |
| 16686       | Jaeger UI                                                                                                                                                                                       | http://localhost:16686 — search by service or `atlas.correlation_id` |
| 4318        | Jaeger OTLP/HTTP                                                                                                                                                                                | `OTEL_EXPORTER_OTLP_ENDPOINT`                                        |

Prometheus scrapes services both as containers (`atlas-services` job) and as host processes
(`atlas-services-host`); whichever mode is not in use shows as down.

## Quality checks

| Command                 | What it runs                                                                                                                           | Needs                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `pnpm check`            | Prettier check, ESLint, type-check, unit tests, build                                                                                  | —                                                      |
| `pnpm test`             | Unit tests (packages, services, portal, database tooling)                                                                              | —                                                      |
| `pnpm test:smoke`       | Starts each **built** service as a process; health, metrics, SIGTERM shutdown; invalid-config refusal                                  | `pnpm build`                                           |
| `pnpm test:integration` | PostgreSQL (incl. migrations up/down/up in a throwaway database), Valkey, RabbitMQ messaging and dead-lettering, service readiness     | `pnpm infra:up` and `.env`                             |
| `pnpm test:e2e`         | Playwright against a portal production build with stubbed APIs (desktop and tablet)                                                    | `pnpm --filter @atlas/e2e-tests install-browsers` once |
| `pnpm test:system`      | Against the running stack: real sign-in, role matrix, tenant isolation, issuer management, audit, service tokens, rate limits, tracing | `pnpm stack:up`, `pnpm db:seed`                        |
| `pnpm test:e2e:stack`   | Browser journeys through Keycloak's real login; writes screenshots to `tests/e2e/screenshots/`                                         | as above                                               |
| `pnpm audit:deps`       | Dependency advisories (fails on high/critical)                                                                                         | network                                                |
| `pnpm format`           | Apply Prettier formatting                                                                                                              | —                                                      |

CI runs all of these on pull requests and pushes to `main` (`.github/workflows/ci.yml`).

## Database workflow

```bash
pnpm db:provision                           # create/update database roles (admin URL)
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
| Portal shows "ATLAS is unavailable"                                 | Start the gateway (`pnpm dev:services` or `pnpm stack:up`)                                                                   |
| Sign-in fails with "invalid credentials" after upgrading            | The realm was imported before Stage 1A: `pnpm identity:reset`                                                                |
| One-time code rejected                                              | Codes are single-use and valid for 30 s: wait for the next one (`pnpm demo:credentials`)                                     |
| Account temporarily locked                                          | Keycloak brute-force protection after 5 failures; wait, or clear it in the admin console (Users → Unlock)                    |
| A service logs `permission denied for schema`                       | It is using another service's credentials, or roles were not provisioned: `pnpm db:provision && pnpm db:migrate`             |
| Portal `502` after recreating the gateway container                 | Fixed in nginx (DNS re-resolution); rebuild the portal image if it predates Stage 1A                                         |
