# @qenbel/db

SQL migrations, Row-Level Security, seed data and small typed helpers for the QenBel Administration database
(Postgres 17). Plain SQL, no ORM. Contracts: `docs/ARCHITECTURE.md` sections 2, 3, 5, 7 and 8.

## Run it

```
docker compose -f infra/docker-compose.yml up -d     # see infra/README.md for infra/.env
npm run migrate -w @qenbel/db                         # apply pending migrations (as qenbel_migrate)
npm run seed -w @qenbel/db                            # two fake tenants; skips tenants already seeded
npm run seed:reset -w @qenbel/db                      # wipe all tenant data (local DB only), then seed
npm run db:check -w @qenbel/db                        # roles, migrations, RLS on every table; exit 1 on failure
npm test -w @qenbel/db                                # node --test against qenbel_admin_test
npm run check -w @qenbel/db                           # typecheck
```

Scripts are `node scripts/db.ts <migrate|seed [--reset]|check> [--test]`. `--test` targets the test database.

Connection settings: `DATABASE_URL` and `DATABASE_MIGRATE_URL` (tests: `TEST_DATABASE_URL`,
`TEST_DATABASE_MIGRATE_URL`). When unset, URLs are built for the docker-compose database from
`POSTGRES_PASSWORD` in `infra/.env`. Tests fail with instructions if the database is unreachable; they never skip.

## TypeScript API (`src/index.ts`)

| Export | Purpose |
| --- | --- |
| `createPool({ connectionString, max?, statementTimeoutMs?, ... })` | `pg.Pool` with statement and idle-in-transaction timeouts and an error handler |
| `withTenant(pool, tenantId, fn, { readOnly?, isolationLevel? })` | One transaction: `BEGIN`, `select set_config('app.tenant_id', $1, true)`, `fn(client)`, `COMMIT` (or `ROLLBACK`). The only way request handlers and jobs touch tenant tables. Rejects non-UUID ids. |
| `runMigrations(pool, { dir?, log? })` | Idempotent runner. Records `(name, checksum)` in `schema_migrations`, one transaction per file, advisory lock, refuses edited files |
| `seed({ appPool, migratePool?, reset?, migrateUrl?, log? })` | Fake data; tenant rows are written through `withTenant` as the runtime role |
| `listActiveTenantIds(pool)`, `expireBookingHolds(pool, now?)` | Worker helpers (visit every tenant; sweep expired holds) |
| `checkDatabase(appPool, migratePool)`, `listTenantTables(db)` | Health and RLS inspection (used by `db:check` and tests) |
| `toPaise(value)` | bigint string from `pg` to a safe-integer number, or throws |

`pg` returns `bigint` columns (`amount_paise`, ...) as strings. Convert with `toPaise`.

## Schema overview

Migrations are in `migrations/NNN_name.sql`, applied in order, immutable once applied.

| File | Contents |
| --- | --- |
| 001 | role check, `btree_gist`, `current_tenant_id()`, `app_set_tenant()`, `set_updated_at()` |
| 002 | platform tables: `tenants`, `platform_admins`, `tool_definitions` (13 tools, seeded), `config_pack_versions` |
| 003 | `locations`, `users`, `user_locations`, `api_credentials`, `tenant_tool_settings` |
| 004 | `customers`, `customer_tags`, `customer_notes` |
| 005 | `catalogue_categories`, `catalogue_items`, `catalogue_variants`, `resources`, `resource_schedules`, `business_hours`, `holidays` |
| 006 | `conversations`, `conversation_messages` |
| 007 | `bookings`, `booking_allocations`, allocation guard trigger, hold expiry functions |
| 008 | `orders`, `order_items`, `payments` (ledger), `fulfilments` |
| 009 | `follow_up_tasks`, `communications`, `notification_templates`, `notifications` |
| 010 | `idempotency_keys`, `audit_log`, `outbox_events`, `webhook_endpoints`, `webhook_deliveries` |
| 011 | RLS on every tenant table, grants, `SECURITY DEFINER` functions |

Conventions (all tenant tables unless noted):

- `id uuid` primary key, `tenant_id` (not null, references `tenants`), `created_at`, `updated_at` (trigger-maintained).
  `audit_log` has no `updated_at` on purpose.
- Every tenant table has `UNIQUE (tenant_id, id)` and children reference parents with **composite foreign keys**
  `(tenant_id, parent_id)`. A row can never point at another tenant's row, even if RLS were misconfigured.
- Enum-like columns are `text` with a `CHECK` using the exact values from `packages/shared/src/enums.ts`. A test compares
  every such constraint to the enums file, so drift fails the suite.
- Money: `*_paise bigint`, `currency char(3) default 'INR'`. Order totals and line totals have consistency CHECKs.
- Times: `timestamptz`. Each location has an IANA `timezone`. Weekly hours use `weekday` 0 (Sunday) to 6 and local `time`.
- Soft delete (`archived_at`): `customers`, `catalogue_items`, `resources`. History-bearing tables are never deleted by the app role.
- `bookings` and `orders` carry `version` (optimistic concurrency), `source_channel`, and a unique human `reference` per tenant.
  `bookings.policy_snapshot` stores the cancellation policy at booking time; `deposit_paise` and `deposit_status` record the deposit.
- A `users` row is one person's membership of one tenant (role `OWNER`, `MANAGER`, `STAFF`). One person in two tenants has two rows.
- `api_credentials` holds API keys (peppered hash only, `pepper_version` for rotation, `tool_scopes` limited to the 13 tool names)
  and public widget keys (`lookup_id` is the key, `allowed_origins`, scoped tools). `lookup_id` is globally unique.
- `payments` is a ledger: the app role may insert, read, and update only `status` and `provider_reference`. Corrections are new rows.
- `outbox_events.event_id` is unique and is the `eventId` sent to webhook subscribers. `type` is limited to the 12 webhook events.

## RLS model

- Roles (created by `infra/postgres/init`, verified by migration 001):
  - `qenbel_migrate`: owns all objects, runs migrations. Not a superuser.
  - `qenbel_app`: the runtime role. `NOBYPASSRLS`, owns nothing, DML grants only (see 011).
  - `qenbel_platform`: `NOLOGIN`, `BYPASSRLS`. Owns only the `SECURITY DEFINER` functions below. Nothing connects as it.
- Every table with a `tenant_id` has `ENABLE` and `FORCE ROW LEVEL SECURITY` (so even the owner is filtered) and one policy:
  `USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`.
  `tenants` has the same policy on `id`.
- `current_tenant_id()` is `nullif(current_setting('app.tenant_id', true), '')::uuid`. A missing or empty setting gives NULL,
  so the comparison is NULL and no rows match. Reads return zero rows and writes fail the `WITH CHECK`, with no error that leaks anything.
  (The contract text casts `current_setting(...)` directly; that raises on the empty string a pooled connection holds after a transaction ends. The `nullif` form is the safe equivalent.)
- `withTenant` sets the setting with `set_config(..., true)`, i.e. transaction-local, so it cannot leak across a pool. A test proves it.
- New tenant tables: call `select app_secure_tenant_table('my_table')` in the migration (enables and forces RLS, creates the policy,
  attaches `set_updated_at`), grant privileges explicitly, and add a row to `test/fixture.ts`. The suite fails otherwise.
- Grants are explicit. `audit_log`: `INSERT, SELECT` only, plus a trigger that rejects `UPDATE` and `DELETE` for every role.
  `conversation_messages`: `INSERT, SELECT`. `payments`: see above. `platform_admins`: no grant at all.

`SECURITY DEFINER` functions (owned by `qenbel_platform`, `search_path` pinned, `EXECUTE` revoked from PUBLIC and granted to `qenbel_app`):

| Function | Use |
| --- | --- |
| `auth_lookup_user(provider, subject)` | Find `(user_id, tenant_id, role)` for a verified identity, before a tenant is known |
| `auth_lookup_credential(lookup_id)` | Find the tenant, hash and scopes of an API key or widget key |
| `auth_is_platform_admin(provider, subject)` | Platform admin check |
| `platform_create_tenant(...)`, `platform_set_tenant_status(...)` | Tenant lifecycle. The API must authorise `PLATFORM_ADMIN` first; the database cannot |
| `platform_list_active_tenants()` | Workers loop over tenants and use `withTenant` for each |
| `expire_booking_holds(now)` | Cross-tenant hold sweep for the job |
| `purge_expired_idempotency_keys()` | Housekeeping |

Everything else, including tenant data, goes through `withTenant` under RLS. There is no bypass for the runtime role.

Seed uses the same path: tenants via `platform_create_tenant`, everything else via `withTenant` as `qenbel_app`.
`seed --reset` runs `TRUNCATE` as the owner (not subject to RLS) and refuses non-local hosts and `NODE_ENV=production`.

## Booking allocations and double-booking prevention

`booking_allocations (tenant_id, booking_id, resource_id, period tstzrange, units, exclusive, active, expires_at)`.

- Periods are half-open `[start, end)` and must be bounded and non-empty (CHECK). 10:00-11:00 and 11:00-12:00 do not overlap.
- Exclusion constraint (as in the contract, plus the `exclusive` flag):
  `EXCLUDE USING gist (tenant_id WITH =, resource_id WITH =, period WITH &&) WHERE (active AND exclusive)`.
  Violations raise SQLSTATE `23P01`; the API maps it to `BOOKING_SLOT_TAKEN`.
- A `BEFORE INSERT/UPDATE` trigger on the allocation takes `FOR NO KEY UPDATE` on the resource row first. That serialises concurrent
  attempts on one resource so losers fail fast. Without it, concurrent inserts detect each other inside the exclusion index and
  deadlock (observed: 20 contenders, 14 deadlocks, 6 statement timeouts, zero winners). With it: 60 rounds of 20 contenders, one winner each, worst round 86 ms.
  A booking that needs several resources must insert its allocations in `resource_id` order.
- `exclusive` is derived from the resource by the trigger; a client cannot set it to bypass the constraint.
- Holds are allocations with `expires_at` (and bookings in `HOLD` with `hold_expires_at`, which is required by a CHECK).
  Confirming a booking (`status -> CONFIRMED`) clears `expires_at`; `CANCELLED`, `EXPIRED` and `NO_SHOW` set `active = false`.
- Hold expiry, three layers: (1) the insert trigger releases any expired hold that overlaps the new period, so an unswept hold never
  blocks a slot; (2) `expire_booking_holds_for_current_tenant(now)` (invoker, under RLS) marks holds `EXPIRED`, bumps `version`, frees allocations;
  (3) `expire_booking_holds(now)` does the same for all tenants, for the background job. The job should run at least every minute.

## Capacity model

`resources.allocation_mode` is `exclusive` (default) or `shared`; `resources.capacity_units` and `min_units` describe size.

1. **Exclusive resources** (staff, doctors, rooms, equipment, vehicles, and restaurant tables). One booking at a time, enforced by the
   exclusion constraint. `capacity_units` is informational for fit: a table's seats, so the engine checks `party_size <= capacity_units`
   and `>= min_units` when choosing tables. A party that needs several tables gets one allocation per table on the same booking.
2. **Shared resources** (a group class, counter seating, a minibus, "dining room covers"). Bookings may overlap as long as the units in use
   never exceed `capacity_units`. Each allocation carries `units` (people or seats, default 1). The trigger computes the **peak concurrent
   usage over the new period** (concurrency peaks at some allocation's start, so it tests the new start and every overlapping start) and
   raises `23P01` (constraint name `booking_allocations_capacity`) if `peak + units > capacity_units`. It does not sum all overlaps, so a
   10:00-12:00 booking of 3 and a 12:00-14:00 booking of 3 leave room for a 11:00-13:00 booking of 1 on capacity 4.
3. `allocation_mode` cannot change, and `capacity_units` cannot shrink, while the resource has active allocations (trigger, SQLSTATE `55000`).

Not modelled yet (Stage 2 booking engine): slot generation from `resource_schedules`, `business_hours`, `holidays` and service
`duration_minutes + buffer_minutes`; staff time off; table-combination rules; status-transition validation (the database checks that a status
is one of the allowed values; `@qenbel/shared` owns which transitions are legal).

## Tests

`test/*.test.ts`, run with `node --test --test-concurrency=1` against `qenbel_admin_test` (migrated and emptied by each file):

| File | Covers |
| --- | --- |
| `rls.test.ts` | Tenant A cannot read, update, delete or insert-for-B on every tenant table (enumerated from the catalog, as the runtime role and as the FORCE-RLS owner); no tenant means zero rows; pool-leak check; composite FKs; the fixture must cover every table |
| `bookings.test.ts` | 20 concurrent overlapping bookings give one winner; touching periods and different resources both succeed; hold expiry (live, swept, lazy, cross-tenant); shared capacity |
| `integrity.test.ts` | audit_log append-only; idempotency unique key, race, 24 h expiry and purge; CHECK constraints reject unknown statuses; ledger limits; enum drift against `enums.ts` |
| `migrate.test.ts` | idempotent runner, ordering, concurrent runners, tamper detection, rollback of a failing file |
| `money.test.ts` | `toPaise` |

## Isolated deployment

Same migrations in a separate database and cluster: create the three roles and the database (adapt `infra/postgres/init`), run
`migrate`, then create the single tenant with `platform_create_tenant(..., 'isolated', ...)`. A unique index allows at most one
`isolated` tenant per database.
