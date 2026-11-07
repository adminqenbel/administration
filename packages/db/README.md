# @qenbel/db

SQL migrations, Row-Level Security, seed data and small typed helpers for the QenBel Administration database
(Postgres 17). Plain SQL, no ORM. Contracts: `docs/ARCHITECTURE.md` sections 2, 3, 5, 7 and 8.

## Run it

```
docker compose -f infra/docker-compose.yml up -d     # see infra/README.md for infra/.env
sh infra/postgres/apply-roles.sh                      # once per existing volume: roles qenbel_auth, qenbel_platform_ops (idempotent)
npm run migrate -w @qenbel/db                         # apply pending migrations (as qenbel_migrate)
npm run seed -w @qenbel/db                            # two fake tenants; skips tenants already seeded
npm run seed:reset -w @qenbel/db                      # wipe all tenant data (local DB only), then seed
npm run db:check -w @qenbel/db                        # roles, migrations, RLS on every table; exit 1 on failure
npm test -w @qenbel/db                                # node --test against qenbel_admin_test
npm run check -w @qenbel/db                           # typecheck
```

Scripts are `node scripts/db.ts <migrate|seed [--reset]|check|tenant-proof <status|enable|disable>> [--test]`. `--test` targets the test database.

Isolating a run: the tests use whatever `TEST_DATABASE_URL` / `TEST_DATABASE_MIGRATE_URL` point at (database name `qenbel_admin_test` is only the default), so a second agent or a
migration experiment can use its own scratch database (`node docs/security/poc/setup-scratch-db.mjs --name=qenbel_admin_<x>_test`) and never touch the shared one.
**Every file in `migrations/` is applied by every test run of every package** (the helpers call `runMigrations`), so a migration under development must not sit
there: keep it in another directory and point `QENBEL_MIGRATIONS_DIR` (ignored when `NODE_ENV=production`) at a copy of `migrations/` plus the new file.

Connection settings (one login role per purpose, SEC-002):

| Variable (tests: `TEST_` prefix) | Role | Use |
| --- | --- | --- |
| `DATABASE_URL` | `qenbel_app` | request and tenant work, always through `withTenant` |
| `DATABASE_AUTH_URL` | `qenbel_auth` | `auth_lookup_user`, `auth_lookup_credential`, `auth_is_platform_admin` only |
| `DATABASE_PLATFORM_URL` | `qenbel_platform_ops` | tenant creation and status, tenant list, hold sweep, idempotency purge, tenant-proof keys |
| `DATABASE_MIGRATE_URL` | `qenbel_migrate` | migrations only |

When unset, URLs are built for the docker-compose database from `infra/.env` (`POSTGRES_PASSWORD`, or `QENBEL_APP_PASSWORD`, `QENBEL_AUTH_PASSWORD`,
`QENBEL_PLATFORM_OPS_PASSWORD`, `QENBEL_MIGRATE_PASSWORD`); the auth and platform URLs reuse the app URL's host, port and database. Tests fail with instructions
if the database is unreachable; they never skip.

## TypeScript API (`src/index.ts`)

| Export | Purpose |
| --- | --- |
| `createPool({ connectionString, max?, statementTimeoutMs?, ... })` | `pg.Pool` with statement and idle-in-transaction timeouts and an error handler |
| `withTenant(pool, tenantId, fn, { readOnly?, isolationLevel?, principal?, proofKey? })` | One transaction: `BEGIN`, `select set_config('app.tenant_id', $1, true), set_config('app.principal', $2, true), set_config('app.tenant_proof', $3, true)`, `fn(client)`, `COMMIT` (or `ROLLBACK`). The only way request handlers and jobs touch tenant tables. Rejects non-UUID ids and malformed principals. `principal` (`user:<uuid>`, `credential:<uuid>`, optional `/conv:<id>`) binds idempotency rows (018). The proof is computed from `proofKey`, else `configureTenantProof()`, else `QENBEL_TENANT_PROOF_KEY` (021). |
| `configureTenantProof(key \| null)`, `tenantProof(key, tenantId)`, `parseTenantProofKey(hex)` | Signed tenant context (SEC-003, migration 021) |
| `runMigrations(pool, { dir?, log? })`, `migrationsDir()` | Idempotent runner. Records `(name, checksum)` in `schema_migrations`, one transaction per file, advisory lock, refuses edited files. Directory: `QENBEL_MIGRATIONS_DIR` outside production, else `migrations/` |
| `seed({ appPool, platformPool, migratePool?, reset?, migrateUrl?, log? })` | Fake data; tenants via `platform_create_tenant` on the platform pool, tenant rows through `withTenant` as the runtime role |
| `listActiveTenantIds(platformPool)`, `expireBookingHolds(platformPool)`, `purgeExpiredIdempotencyKeys(platformPool)` | Worker helpers; the pool must log in as `qenbel_platform_ops`. The sweep always uses the database clock (no `now` argument since 017) |
| `checkDatabase(appPool, migratePool, { platformPool?, authPool? })`, `listTenantTables(db)`, `executableFunctions(db, grantee)`, `FUNCTION_ALLOW_LIST` | Health, RLS and function-privilege inspection (used by `db:check` and tests) |
| `resolveDatabaseUrls(db)`, `requireLeastPrivilegeUrls(urls)`, `deriveRoleUrl(appUrl, role)` | Connection URLs for the four roles |
| `createTestTenant(appPoolOrUrl, { slug?, slugPrefix?, name?, packId?, packVersion?, timezone?, id?, deploymentMode? })`, `setTestTenantStatus(target, id, status)`, `withTestPlatformClient(target, fn)`, `withTestAuthClient(target, fn)` | **Test only.** Log in as `qenbel_platform_ops` / `qenbel_auth` on the same host and database as the given app pool or URL (password from `QENBEL_PLATFORM_OPS_PASSWORD` / `QENBEL_AUTH_PASSWORD`, else `POSTGRES_PASSWORD` in `infra/.env`), one connection per call. Refuse unless the database name ends in `_test`, and under `NODE_ENV=production`. Defaults: pack `salon` `1.0.0`, `central`, `Asia/Kolkata` |
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
| 012 | webhook / outbox event CHECKs: 12 -> 15 events (`booking.expired`, `order.rejected`, `payment.refunded`) |
| 013 | `resource_time_off`, `resource_breaks`, `resource_services`; moves `resources.attributes.{timeOff,breaks,serviceIds}` into them (`app_move_resource_extras()`) |
| 014 | customers: partial unique indexes on active phone and `lower(email)` per tenant; clears pre-existing duplicates safely |
| 015 | `orders.discount_type/_value/_reason/_cap_override`, `orders.resource_id`, `order_items.tax_rate_bps`; backfills |
| 016 | one lock order (resource -> booking -> allocation) for the allocation trigger and both hold sweeps (fixes a 40P01 deadlock) |
| 017 | privilege split (SEC-001/002): no PUBLIC EXECUTE except `current_tenant_id()`, `ALTER DEFAULT PRIVILEGES`, `qenbel_auth` / `qenbel_platform_ops` grants, `app_set_tenant` no longer callable, `expire_booking_holds()` without a clock argument, `platform_create_tenant_with_owner(...)` |
| 018 | `idempotency_keys.principal` (from `app.principal`), unique `(tenant_id, principal, key, route)` under the old constraint name, RESTRICTIVE `principal_binding` policy, `current_principal()` (SEC-010) |
| 019 | `webhook_url_is_safe(url)` CHECK (https, DNS name, no IP literals, no internal suffixes, ports 443/8443, no userinfo); `secret_key_version`, `previous_secret_ciphertext`, `previous_secret_expires_at` (SEC-012, SEC-019) |
| 020 | `users_identity_active_unique (auth_provider, external_subject) WHERE disabled_at IS NULL`; duplicate clean-up with audit rows; deterministic `auth_lookup_user` (SEC-013) |
| 021 | signed tenant context, opt-in: `tenant_proof_keys`, `app_hmac_sha256`, `current_tenant_id()` checks `app.tenant_proof` when a key is installed, policies use `(SELECT current_tenant_id())`, `platform_set_tenant_proof_keys` / `platform_clear_tenant_proof_keys` / `platform_tenant_proof_enabled` (SEC-003) |

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
- `outbox_events.event_id` is unique and is the `eventId` sent to webhook subscribers. `type` is limited to the 15 webhook events (`WebhookEvent`).
- Resource availability: `resource_schedules` (weekly shifts), `resource_breaks` (weekly breaks, `weekday` 0-6, one row per weekday), `resource_time_off`
  (`starts_at`/`ends_at`, half-open, `reason`, `created_by_user_id`) and `resource_services` (unique `(resource_id, catalogue_item_id)`; no rows = any service of the
  matching `required_resource_type`). All have composite tenant FKs, RLS, and `DELETE` for the app role (editable lists).
- Customers: among customers with `archived_at IS NULL`, `(tenant_id, phone)` and `(tenant_id, lower(email))` are unique (`customers_active_phone_unique`,
  `customers_active_email_unique`, SQLSTATE `23505`). `phone` is already E.164 by CHECK, so there is no second column. Un-archiving a customer whose number was
  reused fails with `23505`.
- Orders: `discount_paise` is the amount taken off; `discount_type` (`fixed` | `percent_bps`) + `discount_value` (paise, or basis points up to 10000) record how, both NULL or both set;
  `discount_cap_override` records an approved discount above the cap. `orders.resource_id` is the dine-in table (composite FK to `resources`). `order_items.tax_rate_bps` (0-10000, default 0) is the rate frozen on the line.

## RLS model

- Roles (created by `infra/postgres/init` and `infra/postgres/apply-roles.sh`, verified by migrations 001 and 017):
  - `qenbel_migrate`: owns all objects, runs migrations. Not a superuser.
  - `qenbel_app`: the runtime role. `NOBYPASSRLS`, owns nothing, DML grants only (see 011). May execute only `current_tenant_id()`, `current_principal()`,
    `webhook_url_is_safe(text)` and `expire_booking_holds_for_current_tenant(timestamptz)` (SECURITY INVOKER, its own tenant only).
  - `qenbel_auth`: LOGIN, no table privilege, executes only the three `auth_*` functions. `statement_timeout` 5 s.
  - `qenbel_platform_ops`: LOGIN, no table privilege, executes only the `platform_*` functions, `expire_booking_holds()` and `purge_expired_idempotency_keys()`.
  - `qenbel_platform`: `NOLOGIN`, `BYPASSRLS`. Owns only the `SECURITY DEFINER` functions below. Nothing connects as it.
  - None of the login roles is a member of another role, so there is no `SET ROLE` path. `test/privileges.test.ts` compares every role's executable functions
    with `FUNCTION_ALLOW_LIST` (`src/inspect.ts`) and fails on any new function that PUBLIC or a login role can run without being listed.
  - Ownership trap (the SEC-001 bug): `GRANT`/`REVOKE` on a function owned by `qenbel_platform` only works while the migration runs `SET LOCAL ROLE qenbel_platform`;
    as `qenbel_migrate` PostgreSQL only warns. The same applies to trusted extensions (owned by the bootstrap superuser), which is why 021 has its own HMAC
    instead of pgcrypto.
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

`SECURITY DEFINER` functions (owned by `qenbel_platform`, `search_path` pinned, never executable by PUBLIC except `current_tenant_id()`):

| Function | Executable by | Use |
| --- | --- | --- |
| `auth_lookup_user(provider, subject)` | `qenbel_auth` | `(user_id, tenant_id, role)` for a verified identity; at most one row (020) |
| `auth_lookup_credential(lookup_id)` | `qenbel_auth` | Tenant, hash and scopes of an API key or widget key |
| `auth_is_platform_admin(provider, subject)` | `qenbel_auth` | Platform admin check |
| `platform_create_tenant(...)`, `platform_create_tenant_with_owner(...)`, `platform_set_tenant_status(...)` | `qenbel_platform_ops` | Tenant lifecycle (the `_with_owner` form inserts tenant, first OWNER and the `platform.tenant.create` audit row in one transaction). The API must authorise `PLATFORM_ADMIN` first; the database cannot |
| `platform_list_active_tenants()` | `qenbel_platform_ops` | Workers loop over tenants and use `withTenant` for each |
| `expire_booking_holds()` | `qenbel_platform_ops` | Cross-tenant hold sweep for the job; database clock only |
| `purge_expired_idempotency_keys()` | `qenbel_platform_ops` | Housekeeping |
| `platform_set_tenant_proof_keys(current, previous?)`, `platform_clear_tenant_proof_keys()`, `platform_tenant_proof_enabled()` | `qenbel_platform_ops` | Tenant-proof key (021) |
| `current_tenant_id()` | PUBLIC | The RLS tenant; with a proof key installed, only when `app.tenant_proof` matches |

Everything else, including tenant data, goes through `withTenant` under RLS. There is no bypass for the runtime role.

Signed tenant context (SEC-003, 021). Off until a key is installed. To turn it on for a database: generate 32 random bytes as hex, give the same value to the API
process as `QENBEL_TENANT_PROOF_KEY`, then `QENBEL_TENANT_PROOF_KEY=<hex> node scripts/db.ts tenant-proof enable` (rotation: put the old key in
`QENBEL_TENANT_PROOF_KEY_PREVIOUS` while the API switches). From then on a transaction without the right proof sees no rows, so every process that uses
`withTenant` on that database needs the key. What it does and does not protect is written at the top of `migrations/021_tenant_proof.sql`. The whole suite
passes with it on (`QENBEL_TENANT_PROOF_KEY=<hex> npm test -w @qenbel/db`).

Idempotency (SEC-010, 018): rows belong to `(tenant, principal)`. A principal sees and writes only its own rows; another credential repeating the same key is a miss.
Callers must pass `withTenant(..., { principal })`; without it all callers share the empty principal (pre-018 behaviour).

Identity (SEC-013, 020): one active membership per `(auth_provider, external_subject)` across all tenants. Adding an identity that is active elsewhere, or
re-enabling a disabled one, fails with `23505` on `users_identity_active_unique`.

Webhook URLs (SEC-012, 019): the database refuses anything `webhook_url_is_safe()` rejects. This is a backstop: the dispatcher must still resolve the host at
delivery time and refuse private, loopback, link-local, CGNAT, unique-local, mapped and metadata addresses, pin the connection to the checked address and
not follow redirects. `http://localhost` is not accepted in any environment.

Seed uses the same path: tenants via `platform_create_tenant` (platform pool), everything else via `withTenant` as `qenbel_app`.
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

## Hold expiry and lock order

Everything that releases or expires holds takes locks in one order: **resource row (ascending id) -> booking rows (ascending id) -> allocation rows**.
The allocation insert trigger (resource, then the bookings of expired overlapping holds, then their allocations) and both sweeps
(`expire_booking_holds`, `expire_booking_holds_for_current_tenant`) follow it; confirm/cancel already did (booking, then the sync trigger updates allocations).
Before migration 016 the trigger went allocation-first and the sweeps booking-first, which deadlocked (`40P01`) when a sweep raced a new hold over unswept expired holds.
`test/hold-sweep-locks.test.ts` forces that interleaving and also races sweeps against inserts. The cross-tenant sweep needs `SELECT` and `UPDATE (updated_at)` on `resources` for `qenbel_platform` (migration 016) to take the resource locks.

## Data migrations under FORCE RLS

The owner role is subject to FORCE RLS, so a migration that rewrites tenant rows runs `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` for the tables it touches, does the work, and forces it again in the same
transaction (013, 014, 015). The runtime role stays filtered throughout. Tests replay these sections inside rolled-back owner transactions.
`select app_move_resource_extras();` (013, owner only) is re-runnable: use it if an engine still wrote the interim `resources.attributes` keys after the migration.

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

Not modelled yet (Stage 2 booking engine): slot generation from `resource_schedules`, `resource_breaks`, `resource_time_off`, `business_hours`, `holidays` and service
`duration_minutes + buffer_minutes`; table-combination rules; status-transition validation (the database checks that a status
is one of the allowed values; `@qenbel/shared` owns which transitions are legal).

## Tests

`test/*.test.ts`, run with `node --test --test-concurrency=1` against `qenbel_admin_test` (migrated and emptied by each file):

| File | Covers |
| --- | --- |
| `rls.test.ts` | Tenant A cannot read, update, delete or insert-for-B on every tenant table (enumerated from the catalog, as the runtime role and as the FORCE-RLS owner); no tenant means zero rows; pool-leak check; composite FKs; the fixture must cover every table |
| `bookings.test.ts` | 20 concurrent overlapping bookings give one winner; touching periods and different resources both succeed; hold expiry (live, swept, lazy, cross-tenant); shared capacity |
| `integrity.test.ts` | audit_log append-only; idempotency unique key, race, 24 h expiry and purge; CHECK constraints reject unknown statuses; ledger limits; enum drift against `enums.ts` |
| `hold-sweep-locks.test.ts` | Sweeps vs the allocation insert trigger: forced lock interleaving (cross-tenant and tenant sweep), randomised races, multi-resource holds, sweep effects |
| `resource-availability.test.ts` | 013 constraints, tenant FKs, the attributes-to-rows move (both engine formats, malformed entries kept, idempotent, FORCE restored) |
| `customers-dedupe.test.ts` | 014 unique indexes (case, archived, tenants, restore, race) and the duplicate clean-up replayed on planted data |
| `orders-discount.test.ts` | 015 discount CHECKs, `resource_id` tenant FK, `tax_rate_bps` bounds, backfill replayed on planted data |
| `privileges.test.ts` | SEC-001/002/003: each role's executable functions equal the allow-list; no definer function is PUBLIC; default privileges; login roles have no table privilege and no membership; the runtime role cannot call any platform or auth function or `app_set_tenant`; the sweep has no clock; `platform_create_tenant_with_owner`; no `set_config` / `SET app.*` in any `apps/*/src` or `packages/*/src` file except `tenant.ts` |
| `security-fixes.test.ts` | SEC-010 idempotency per principal; SEC-012 webhook URLs (33 refused, 6 accepted); SEC-013 identity uniqueness and the 020 clean-up; SEC-003 tenant proof (switching tenant fails closed, forged or missing proof, key unreadable, rotation, HMAC against RFC 4231, plan uses an InitPlan) |
| `migrate.test.ts` | idempotent runner, ordering, concurrent runners, tamper detection, rollback of a failing file |
| `money.test.ts` | `toPaise` |

## Isolated deployment

Same migrations in a separate database and cluster: create the five roles and the database (adapt `infra/postgres/init`; `apply-roles.sh` creates the two login roles), run
`migrate`, then create the single tenant with `platform_create_tenant(..., 'isolated', ...)`. A unique index allows at most one
`isolated` tenant per database.
