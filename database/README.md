# Database

Versioned migrations, development seeds and tooling. Each subdirectory of `migrations/` is a PostgreSQL
schema owned by exactly one service; see [DATA_MODEL.md](../docs/architecture/DATA_MODEL.md).

```bash
pnpm db:migrate | db:status | db:rollback --owner <schema> [--count n] | db:seed
```
