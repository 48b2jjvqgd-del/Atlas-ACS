# syntax=docker/dockerfile:1
#
# Builds any ATLAS service (or the database migrator) into its own minimal image.
#
#   docker build -f infrastructure/docker/service.Dockerfile --build-arg SERVICE=acs-core -t atlas/acs-core .
#   docker build -f infrastructure/docker/service.Dockerfile --target migrator -t atlas/migrator .
#
# The build stage is identical for every service and is cached once; only the final
# `pnpm deploy` differs, so building all services costs little more than building one.

ARG NODE_IMAGE=node:24.22-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install --global --no-fund --no-audit pnpm@12.16.1
WORKDIR /repo

FROM base AS build
# The package store is kept in an image layer, not a BuildKit cache mount: CI restores layers
# from its build cache but never cache mounts, so `install --offline` would find an empty store.
# This layer only rebuilds when the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm -r --filter "./packages/**" --filter "./services/**" --filter ./database run build

FROM build AS deploy-service
ARG SERVICE
RUN test -n "${SERVICE}" || (echo "SERVICE build argument is required" && exit 1)
RUN pnpm --filter "@atlas/${SERVICE}" deploy --prod /out

FROM build AS deploy-migrator
RUN pnpm --filter @atlas/database deploy --prod /out

# ---- Database migrator (one-shot) ----
FROM ${NODE_IMAGE} AS migrator
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deploy-migrator --chown=node:node /out ./
USER node
ENTRYPOINT ["node", "dist/cli/migrate.js"]
CMD ["up"]

# ---- Service runtime (default target) ----
FROM ${NODE_IMAGE} AS service
ARG SERVICE
ARG BUILD_SHA=
ENV NODE_ENV=production HOST=0.0.0.0 ATLAS_BUILD_SHA=${BUILD_SHA}
LABEL org.opencontainers.image.title="atlas-${SERVICE}" \
      org.opencontainers.image.description="ATLAS ACS ${SERVICE} (non-production)" \
      org.opencontainers.image.source="https://github.com/48b2jjvqgd-del/Atlas-ACS"
WORKDIR /app
COPY --from=deploy-service --chown=node:node /out ./
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --start-interval=1s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# exec form: node is PID 1 and receives SIGTERM directly for graceful shutdown
CMD ["node", "dist/index.js"]
