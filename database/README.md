# Database

Versioned migrations, development seeds and tooling. Each subdirectory of `migrations/` is a PostgreSQL
schema owned by exactly one service; see [DATA_MODEL.md](../docs/architecture/DATA_MODEL.md).

```bash
pnpm db:migrate | db:status | db:rollback --owner <schema> [--count n] | db:seed
```

After every `db:migrate` run the tool, as `atlas_migrator`, re-applies each service role's grants
(`src/roles.ts`) and synchronises the authorisation catalogue and system roles from `@atlas/contracts`
into `identity` (`src/catalogue.ts`, ADR-035). Neither step is ever done by a running service.
