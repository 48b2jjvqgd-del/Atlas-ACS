# Stage 1A screenshots

Captured automatically by the full-stack browser journeys (`pnpm test:e2e:stack`) against the running
stack with synthetic data, signing in through Keycloak's real login pages. CI regenerates them on every
run (artifact `stage-1a-screenshots`). Rows such as "Journey Analyst" are users created by earlier
test runs.

| File                                                   | Who                                     | What                                                    |
| ------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------- |
| `platform-overview.png`                                | Platform Administrator                  | issuer counts, recent activity, health                  |
| `issuer-registry.png`, `issuer-create.png`             | Platform Administrator                  | registry and creation form                              |
| `issuer-configuration.png`, `issuer-audit-history.png` | Platform Administrator                  | versioned configuration; audit with before/after values |
| `platform-users.png`, `roles-and-permissions.png`      | Platform Super Admin                    | platform users; permission matrix                       |
| `audit-explorer.png`, `system-health.png`              | Platform Super Admin                    | chain verification; service readiness                   |
| `issuer-overview.png`, `issuer-users.png`              | Issuer Administrator (Northstar)        | issuer workspace; user invitation                       |
| `restricted-user.png`, `account-security.png`          | Customer Support (Northstar)            | restricted navigation; account and session              |
| `tablet-issuer-users.png`                              | Issuer Administrator (Meridian), tablet | responsive layout                                       |
