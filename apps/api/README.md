# @qenbel/api

NestJS 12 (Express adapter) modular monolith for QenBel Administration. Stage 2 delivers the platform core: config,
authentication, tenancy, authorisation, idempotency, errors, audit, rate limiting, health and the platform/onboarding
endpoints. Domain controllers (bookings, orders, customers...) come in Stage 3 and plug into the pieces below.

Domain logic stays in plain TS packages (`packages/engine-*`). Controllers are thin: validate, call an engine with
`(tx.sql, tx.ctx, input)`, return.

## Run it

```
docker compose -f infra/docker-compose.yml up -d        # Postgres :54329, Redis :63799
npm run migrate -w @qenbel/db && npm run seed -w @qenbel/db
npm run build -w @qenbel/api
NODE_ENV=development AUTH_PROVIDER=dev API_KEY_PEPPER=<32+ random chars> npm start -w @qenbel/api
```

`DATABASE_URL` may be omitted in development: it is derived from `POSTGRES_PASSWORD` in `infra/.env`, as in `@qenbel/db`.
The dev provider reads `Authorization: Bearer dev|<subject>` for an existing user, for example `dev|salon-owner` or
`dev|platform-admin` after `seed`.

Why compiled output: Nest needs decorator metadata, which Node's type stripping cannot produce. `tsconfig.json` enables
`experimentalDecorators`/`emitDecoratorMetadata` and writes to `dist/`. Workspace packages (`@qenbel/*`) are loaded as
TypeScript source by Node itself.

```
npm run build -w @qenbel/api     # tsc -> dist/
npm run check -w @qenbel/api     # typecheck only
npm test -w @qenbel/api          # build, then node --test on dist/test/**/*.test.js
```

Tests run for real against Docker Postgres in their own database, `qenbel_admin_api_test`, so they never collide with the
db package's `qenbel_admin_test`. Create it once (the Redis limiter test also needs the Docker Redis):

```
docker exec qenbel-admin-db psql -U postgres -c "CREATE DATABASE qenbel_admin_api_test OWNER qenbel_migrate"
# then the same REVOKE/GRANT/CREATE EXTENSION btree_gist block as infra/postgres/init/01-roles-and-databases.sh
```

Tests do not skip when infrastructure is down; they fail with instructions.

## Environment

Names only; see the repository `.env.example`. Invalid or missing values stop start-up with a list of variable names
and rules (never values). `NODE_ENV` unset means production.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | production | `development`, `test`, `production` |
| `DEPLOYMENT_MODE` | central | `isolated` serves exactly one tenant |
| `ISOLATED_TENANT_ID` | none | UUID, required (and only valid) when isolated |
| `HOST`, `PORT` | 127.0.0.1, 4000 | |
| `PUBLIC_API_ORIGIN`, `PUBLIC_WEB_ORIGIN` | localhost (dev/test only) | https in production; the web origin is the only CORS origin |
| `DATABASE_URL` | none | runtime role `qenbel_app` (subject to RLS) |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS` | 10, 15000 | |
| `REDIS_URL` | off | rate-limit store; falls back to memory if Redis is down |
| `AUTH_PROVIDER` | clerk | `dev` only when `NODE_ENV=development` and `HOST` is loopback |
| `CLERK_JWT_KEY`, `CLERK_ISSUER` | none | PEM public key (no network on the hot path) and issuer; required for clerk |
| `CLERK_AUTHORIZED_PARTIES` | `PUBLIC_WEB_ORIGIN` | comma separated; token `azp` must match |
| `API_KEY_PEPPER`, `API_KEY_PEPPER_VERSION` | none, 1 | pepper at least 32 chars; credentials made under another version are refused |
| `TRUST_PROXY` | 0 | proxies in front of the API (client address for rate limits) |
| `BODY_LIMIT_BYTES` | 262144 | |
| `LOG_LEVEL` | info | |
| `RATE_LIMIT_WINDOW_SECONDS`, `RATE_LIMIT_IP_MAX`, `RATE_LIMIT_PUBLIC_MAX`, `RATE_LIMIT_PRINCIPAL_MAX`, `RATE_LIMIT_AUTH_FAIL_MAX` | 60, 600, 60, 600, 20 | |
| `IDEMPOTENCY_WAIT_MS`, `IDEMPOTENCY_LOCK_TIMEOUT_MS` | 5000, 60000 | how long a duplicate waits; when a dead first attempt may be taken over |
| `SHUTDOWN_TIMEOUT_MS` | 10000 | |

`CLERK_ISSUER`, `CLERK_AUTHORIZED_PARTIES`, `ISOLATED_TENANT_ID` and the tuning variables are not yet in the root
`.env.example` (recorded in `docs/CONTRACT-REQUESTS.md`).

## Request pipeline

1. Express middleware: request id, access log (no headers, query or body), security headers, CORS (one origin, no credentials), JSON-only body check, JSON parser (256 KB).
2. `AccessGuard` (global, deny by default): route has no declared policy -> 403; per-address rate limit; `@Public()` passes; otherwise sign-in lockout check, authentication, authorisation (403 and an audit row with outcome `denied`), per-principal rate limit, refusal of any tenant/organisation id in query or body.
3. `TenantUnitOfWorkInterceptor` (global): for a principal with a tenant, one `withTenant` transaction per request (read-only for GET/HEAD). Handlers receive `@Tx()` = `{ tenantId, sql, ctx }` where `ctx` is the `EngineContext` from `@qenbel/shared`. `@Idempotent()` routes open the same transaction themselves after claiming the key.
4. Pipes: `zodPipe(schema)` (use `z.strictObject`) -> `VALIDATION_FAILED` without echoing values.
5. `AllExceptionsFilter`: `AppError`, zod, HttpException, body-parser and Postgres SQLSTATE errors -> `{ "error": { code, message, details } }`. SQL text, constraint names and stack traces go to the log only.

Authentication: `Authorization: Bearer <token>` only (no cookies, so no CSRF surface). A token starting `qbk_` is an API credential; anything else goes to the `AuthProvider` (`dev` or `clerk`), then `auth_lookup_user` / `auth_is_platform_admin`. Tenant, role and permissions come from the database row, never from the request. Unknown, deactivated and suspended-tenant users get the same 403; all token and credential failures get the same 401.

API credentials: `qbk_<12 chars>.<43 chars>`; only `HMAC-SHA256(API_KEY_PEPPER, lookupId + "." + secret)` is stored, compared in constant time; shown once in the creation response. Credentials are refused on every route unless it says `@AllowApiCredential()` (currently only `GET /v1/me`); their permissions are the `requiredPermission` of their allowed tools.

## Declaring a route

```ts
@Permission(ApiPermission.BOOKINGS_WRITE)   // or @Public(), @Authenticated(), @PlatformAdmin()
@Idempotent()                               // optional; requires Idempotency-Key
@Post()
create(@Body(zodPipe(schema)) body: In, @Tx() tx: TenantTx) { return engine(tx.sql, tx.ctx, body); }
```

`test/routes.test.ts` enumerates every controller route (`listRoutes`) and fails if one has no declared policy, and its
expected-route list must be updated deliberately when a route is added.

## Permissions (final list)

`@qenbel/shared` strings: `bookings:read|write`, `orders:read|write`, `customers:read|write`, `catalogue:read|write`,
`resources:read|write`, `business:read|write`, `integrations:manage`, `users:manage`, `audit:read`, `reports:read`.
Added here (to move into `@qenbel/shared`): `dashboard:read`, `tasks:read|write`, `conversations:read|write`,
`payments:read|write`, `integrations:read`, `users:read`, `business:pack`. `tasks:write` is what the tool registry's
`escalate_to_human` needs; a test checks every tool's `requiredPermission` is in this list.

| Role | Permissions |
| --- | --- |
| OWNER | all |
| MANAGER | bookings, orders, customers, catalogue, resources (read/write); `business:read`; `audit:read`; `reports:read`; dashboard, tasks, conversations; `payments:*`; `integrations:read`; `users:read` |
| STAFF | bookings, orders, customers (read/write); catalogue, resources, business (read); dashboard, tasks, conversations |
| PLATFORM_ADMIN | none on tenant data; `@PlatformAdmin()` routes only |

Where `docs/API-CONTRACT.md`'s proposed matrix and `@qenbel/shared` disagree (MANAGER `business:write`), `@qenbel/shared` wins.

## Routes

| Method and path | Access | Notes |
| --- | --- | --- |
| `GET /health`, `GET /health/db` | public | liveness; database readiness (503 generic on failure) |
| `GET /v1/me` | authenticated, credentials allowed | principal, tenant, pack terminology |
| `GET /v1/business/profile` | `business:read` | tenants row |
| `PUT /v1/business/profile` | `business:write` | `name`, `defaultTimezone`; audited |
| `GET/POST /v1/integrations/api-credentials`, `POST .../:credentialId/revoke` | `integrations:read` / `integrations:manage` | key shown once |
| `POST /v1/platform/tenants` | platform admin | one transaction: `platform_create_tenant`, OWNER user, audit row |

## Module map

```
src/main.ts, bootstrap.ts, shutdown.ts   start-up, createApp(), graceful close
src/app.module.ts, core.module.ts        module wiring; global providers, guard, interceptor, filter
src/config/                              typed env config, fail fast, dev-provider safety checks
src/common/                              logger + redaction, http middleware, request state, DI tokens
src/auth/                                AuthProvider (dev, clerk), API keys, AuthenticationService, Principal
src/authz/                               decorators, permissions, AccessGuard, route inventory
src/tenancy/                             UnitOfWork + global interceptor (withTenant per request)
src/idempotency/                         store (idempotency_keys) + @Idempotent() interceptor
src/errors/                              filter, normalisation, SQLSTATE mapping, zod pipe
src/audit/                               AuditService (in-transaction and separate-transaction writes)
src/ratelimit/                           in-memory, Redis and fallback limiters
src/health, me, business, credentials, platform/   feature modules
test/                                    node --test over dist/, real Postgres and Redis
```

## Behaviour notes

- Idempotency: key unique per `(tenant, key, route)`, 24 h. Same request replays the stored status and body (`Idempotent-Replayed: true`); a different request is 409 `IDEMPOTENCY_CONFLICT` (`details.reason: different_request`); a concurrent duplicate waits up to `IDEMPOTENCY_WAIT_MS`, then 409 (`in_progress`, `Retry-After: 1`). 4xx business errors (404, 409, 410, 422) are stored; 400/401/403/429 and 5xx release the key. The response is stored in the same transaction as the work.
- Audit: sensitive successes are written inside the request transaction; denials in their own short transaction. `audit_log` needs a tenant, so unauthenticated failures go to the log only.
- Rate limits: per address (public and authenticated), per principal, and a sign-in failure lockout per address; `RateLimit-*` headers and `Retry-After` on 429.
- Isolated mode: users and credentials whose tenant is not `ISOLATED_TENANT_ID` are refused; `POST /v1/platform/tenants` creates that one tenant (a second is 409).
- Not yet: raw-body capture for signed inbound webhooks, `last_used_at` updates for credentials, widget keys, the tool gateway (Stage 3).
