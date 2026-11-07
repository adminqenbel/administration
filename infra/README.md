# infra

Local development services for QenBel Administration. Nothing here is a production deployment.

| Service | Container | Host port | Notes |
| --- | --- | --- | --- |
| Postgres 17 | `qenbel-admin-db` | 54329 | databases `qenbel_admin` (dev) and `qenbel_admin_test` (tests) |
| Redis 7 | `qenbel-admin-redis` | 63799 | password required |
| MinIO (S3 compatible) | `qenbel-admin-minio` | 9100 (S3 API), 9101 (console) | |

All ports are bound to `127.0.0.1`. The QenBel portal uses 5432/5434, so these ports do not clash with it.

## Start

1. Create `infra/.env` (git-ignored). Names are in `infra/.env.example`. Any values work for local use:

   ```
   POSTGRES_PASSWORD=...
   REDIS_PASSWORD=...
   MINIO_ROOT_USER=...
   MINIO_ROOT_PASSWORD=...        # MinIO needs at least 8 characters
   ```

   Optional: `QENBEL_APP_PASSWORD`, `QENBEL_MIGRATE_PASSWORD`, `QENBEL_AUTH_PASSWORD`, `QENBEL_PLATFORM_OPS_PASSWORD` (default to `POSTGRES_PASSWORD`,
   local development only; `QENBEL_REQUIRE_DISTINCT_PASSWORDS=1` makes the last two mandatory).

2. From the repo root:

   ```
   docker compose -f infra/docker-compose.yml up -d
   sh infra/postgres/apply-roles.sh          # existing volumes only; a new volume gets the roles from init/02
   npm run migrate -w @qenbel/db
   npm run seed -w @qenbel/db
   ```

   `npm run infra:up -w @qenbel/db` is a shortcut for the first command.

3. Stop with `docker compose -f infra/docker-compose.yml down` (data is kept in named volumes; add `-v` to delete it).

## Database roles

`infra/postgres/init/01-roles-and-databases.sh` runs once, when the Postgres volume is first created, as the
superuser. It creates:

- `qenbel_migrate`: owns the schema, runs migrations. Not a superuser.
- `qenbel_app`: runtime role. `NOBYPASSRLS`, owns nothing, only the grants in migration 011.
- `qenbel_platform`: `NOLOGIN`, `BYPASSRLS`. Owns a few `SECURITY DEFINER` functions. Nothing connects as it.

Then `infra/postgres/init/02-app-roles.sh` adds the least-privilege login roles (SEC-002 in `docs/security/REVIEW-stage2.md`):

- `qenbel_auth`: executes only `auth_lookup_user`, `auth_lookup_credential`, `auth_is_platform_admin`. No table privilege. For the authentication lookups.
- `qenbel_platform_ops`: executes only the `platform_*` functions, `expire_booking_holds()` and `purge_expired_idempotency_keys()`. No table privilege.
  For the platform controller and the background jobs.

The init scripts run only on the first start of an empty volume. For an existing volume run, as often as you like:

```
sh infra/postgres/apply-roles.sh                     # qenbel_admin, qenbel_admin_test, qenbel_admin_api_test
sh infra/postgres/apply-roles.sh my_scratch_test     # or only the databases you name
```

It runs `02-app-roles.sh` inside the container as the superuser (`docker exec`; `QENBEL_DB_CONTAINER` overrides the name,
`QENBEL_APPLY_ROLES_LOCAL=1` uses your own `psql` and `PG*` variables instead). It creates or updates the two roles (attributes, password,
timeouts), grants `CONNECT` and schema `USAGE`, and refuses if any QenBel login role has a role membership. Function grants are made by
migration 017, so run the migrations afterwards. Passwords are passed by name, never on the command line.

If you change `01-roles-and-databases.sh` or its passwords after the first start, remove the volume
(`docker compose -f infra/docker-compose.yml down -v`) so it runs again.

Connection URLs, if you want to set them yourself (the db package builds them from `infra/.env` when unset):

```
DATABASE_URL=postgres://qenbel_app:<password>@localhost:54329/qenbel_admin
DATABASE_MIGRATE_URL=postgres://qenbel_migrate:<password>@localhost:54329/qenbel_admin
DATABASE_AUTH_URL=postgres://qenbel_auth:<password>@localhost:54329/qenbel_admin
DATABASE_PLATFORM_URL=postgres://qenbel_platform_ops:<password>@localhost:54329/qenbel_admin
```

## Notes

- The official `minio/minio` image could not be pulled from Docker Hub or quay.io when this was set up, so the
  compose file uses `cgr.dev/chainguard/minio:latest` (MinIO built by Chainguard, same command line). Swap the
  image line if you prefer another S3-compatible store; only the `S3_*` variables matter to the app.
- Redis and MinIO are not used by Stage 1 code yet. They are here so later stages share one compose file.
- An isolated customer deployment uses the same schema in its own database. See `packages/db/README.md`.
