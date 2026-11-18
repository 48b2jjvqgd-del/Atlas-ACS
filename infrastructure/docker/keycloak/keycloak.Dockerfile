# syntax=docker/dockerfile:1
#
# Keycloak for local development and CI, pre-built ("optimized"). start-dev re-runs Keycloak's
# Quarkus build on every container start (~15 s); building once here lets compose start it
# with `start --optimized`. Build-time options live here; runtime options stay in compose.yaml.
# Nothing here is suitable for production (HTTP only, local caches, generated admin).

ARG KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.8.0

FROM ${KEYCLOAK_IMAGE} AS builder
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_CACHE=local
RUN /opt/keycloak/bin/kc.sh build

FROM ${KEYCLOAK_IMAGE}
COPY --from=builder /opt/keycloak/ /opt/keycloak/
