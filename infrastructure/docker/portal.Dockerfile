# syntax=docker/dockerfile:1
# Builds the ATLAS portal as static assets served by unprivileged nginx, proxying /api to the gateway.

ARG NODE_IMAGE=node:24.22-alpine

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install --global --no-fund --no-audit pnpm@12.16.1
WORKDIR /repo
# The package store is kept in an image layer, not a BuildKit cache mount: CI restores layers
# from its build cache but never cache mounts, so `install --offline` would find an empty store.
# This layer only rebuilds when the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @atlas/portal... run build

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
COPY infrastructure/docker/portal/nginx.conf /etc/nginx/conf.d/default.conf
COPY infrastructure/docker/portal/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/portal/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --start-interval=1s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
