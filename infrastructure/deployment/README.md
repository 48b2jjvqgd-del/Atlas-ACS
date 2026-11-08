# Deployment

**No deployment targets exist in Stage 0**, by design: nothing is deployed beyond local Docker Compose,
and no orchestration platform (e.g. Kubernetes) is introduced before it is needed.

What every target must provide, based on the existing artefacts:

- one container per service from `infrastructure/docker/service.Dockerfile` (`--build-arg SERVICE=…`);
- the `migrator` image run as a one-shot job before services start;
- environment variables per [CONVENTIONS.md](../../docs/architecture/CONVENTIONS.md#configuration), with
  secrets mounted as files (`*_FILE`);
- liveness on `/health/live`, readiness on `/health/ready`, metrics scraping on `/metrics`;
- `SIGTERM` with a grace period of at least `SHUTDOWN_TIMEOUT_MS` (default 10 s).

Target-specific descriptors (for example `deployment/kubernetes/`) will be added here when a target is
chosen, following [MIGRATION_STRATEGY.md](../../docs/MIGRATION_STRATEGY.md).
