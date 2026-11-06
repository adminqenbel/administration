# QenBel Administration: architecture contracts

Locked. Parallel agents build against this file. Change it only through the coordinator.

## 1. Shape

Multi-tenant business operations platform: bookings, orders, customers, staff and resources, catalogue, AI tool gateway, AI agent runtime (website chat, WhatsApp), voice via external providers. Industry behaviour comes from **config packs**, not code forks. Central cloud by default; the same build runs as a single-tenant isolated stack (`DEPLOYMENT_MODE=isolated`).

npm workspaces monorepo, scope `@qenbel/*`, TypeScript, Node >= 22.18.

```
apps/api            NestJS modular monolith           @qenbel/api
apps/web            React + Vite PWA                  @qenbel/web
apps/widget         embeddable chat widget            @qenbel/widget
apps/desktop        Tauri 2 shell (later)
apps/mobile         Capacitor shell (later)
packages/shared     enums, zod schemas, state machines, error codes, money helpers   @qenbel/shared
packages/db         SQL migrations, RLS, seed, typed query helpers                   @qenbel/db
packages/config-packs   industry packs (salon, clinic, restaurant first)             @qenbel/config-packs
packages/tool-registry  AI tool definitions -> JSON Schema / OpenAPI / MCP           @qenbel/tool-registry
packages/ui         QenBel design tokens, fonts, shared components                   @qenbel/ui
packages/api-client generated typed client                                           @qenbel/api-client
infra               docker-compose, Dockerfiles, isolated-deploy template
docs                requirements, contracts, runbooks
```

## 2. Naming and data conventions

- DB: `snake_case`, plural table names. TS: `camelCase` fields, `PascalCase` types. Wire JSON: `camelCase`.
- Every tenant table: `id uuid pk default gen_random_uuid()`, `tenant_id uuid not null references tenants(id)`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`. Platform tables (`tenants`, `platform_admins`, `tool_definitions`, `config_pack_versions`) have no `tenant_id`.
- Money: `amount_paise bigint`, `currency char(3) default 'INR'`. No floats anywhere.
- Time: `timestamptz`, stored UTC. Each location has an IANA `timezone`; availability is computed in that zone.
- Soft delete only where history matters (`customers`, `catalogue_items`, `resources`): `archived_at timestamptz null`.
- Optimistic concurrency on bookings, orders: `version int not null default 1`.
- Enum-like values are stored as `text` with a `CHECK` constraint, and exported from `@qenbel/shared` as `as const` objects plus union types (no TS `enum`).

## 3. Tenancy and database roles

- `tenant_id` comes from the authenticated principal only. Never from request body, query, path or AI tool arguments.
- Roles: `qenbel_migrate` (owns schema), `qenbel_app` (runtime, subject to RLS, no BYPASSRLS). Platform-level work (tenant creation, provisioning) goes through a small set of `SECURITY DEFINER` functions or a separate `qenbel_platform` role, never by disabling RLS.
- Each request or job runs in one transaction that begins with `select set_config('app.tenant_id', $1, true)`. Policy on every tenant table: `using (tenant_id = current_setting('app.tenant_id', true)::uuid) with check (same)`. Missing setting = no rows.
- Isolated deployment: same schema, one row in `tenants`, own database.

## 4. Principals and permissions

Principal kinds: `user` (browser/app, session verified server-side), `api_credential` (tenant-scoped, per integration, carries an allowed tool list), `system` (jobs).

User roles (tenant): `OWNER`, `MANAGER`, `STAFF`. Platform: `PLATFORM_ADMIN`. Permission strings: `<module>:<action>` e.g. `bookings:read`, `bookings:write`, `orders:write`, `customers:read`, `catalogue:write`, `resources:write`, `business:write`, `integrations:manage`, `audit:read`, `reports:read`.

Auth is behind an `AuthProvider` interface. Implementations: `dev` (fake identity; only if `NODE_ENV=development` and bound to localhost; a test proves it cannot run otherwise) and `clerk` (verify the session token ourselves: signature, expiry, authorised party, issuer; matches the QenBel portal). API credentials are random secrets stored as peppered hashes; shown once.

## 5. State machines (data, defined in packs, validated by `@qenbel/shared`)

Booking: `HOLD -> CONFIRMED -> CHECKED_IN -> COMPLETED`; also `HOLD -> EXPIRED`, `HOLD|CONFIRMED -> CANCELLED`, `CONFIRMED -> NO_SHOW`, `CONFIRMED -> CONFIRMED` (reschedule, version bump).
Order: `DRAFT -> PLACED -> ACCEPTED -> PROCESSING -> READY -> FULFILLED`; also `DRAFT|PLACED|ACCEPTED -> CANCELLED`, `PLACED -> REJECTED`, `FULFILLED|(paid) -> REFUNDED`.
A pack may narrow or relabel transitions (e.g. restaurant `PROCESSING` shown as "Preparing"); it may not add statuses outside these sets.

Double booking is prevented in the database: table `booking_allocations (tenant_id, booking_id, resource_id, period tstzrange, active bool)` with `EXCLUDE USING gist (tenant_id WITH =, resource_id WITH =, period WITH &&) WHERE (active)`. Holds are allocations with `expires_at`; a job sets expired holds `EXPIRED` and `active=false`. Capacity-based resources (tables, group seats) use a `capacity_units` allocation model defined by the db agent and documented in `packages/db/README.md`.

## 6. AI tools (registry names are final)

| Tool | Level | Notes |
| --- | --- | --- |
| `get_business_profile` | READ | |
| `search_customer` | READ | by phone/email/name; returns minimal fields |
| `get_catalogue` | READ | |
| `check_availability` | READ | |
| `create_booking_hold` | WRITE | idempotent |
| `confirm_booking` | CONTROLLED_WRITE | requires live hold, pack-defined required fields |
| `reschedule_booking` | CONTROLLED_WRITE | |
| `cancel_booking` | CONTROLLED_WRITE | applies cancellation policy |
| `get_order_status` | READ | |
| `create_order_draft` | WRITE | idempotent |
| `confirm_order` | CONTROLLED_WRITE | |
| `cancel_order` | CONTROLLED_WRITE | |
| `escalate_to_human` | WRITE | creates a follow-up task and flags the conversation |

All write tools require an `Idempotency-Key`. A tool is usable only if (a) the pack allows it, (b) the tenant enabled it, (c) the credential or channel is scoped to it. Tool input is re-validated server-side; the model's arguments are untrusted.

## 7. API conventions

REST under `/v1`, JSON, OpenAPI 3.1 generated from zod schemas. Errors: `{ "error": { "code": "BOOKING_SLOT_TAKEN", "message": "...", "details": {} } }` with codes exported from `@qenbel/shared`. Pagination: `?limit=&cursor=`. Idempotency: header `Idempotency-Key`, stored per `(tenant_id, key, route)` with response replay for 24 h. Gateway for external agents: `/v1/tools/{toolName}`, plus `/v1/tools/openapi.json`. Public chat: `/v1/public/chat/*` scoped by a public widget key that maps to one tenant and carries only chat-safe tools.

## 8. Webhooks and events

Outbound, signed (HMAC-SHA256, `QenBel-Signature: t=<unix>,v1=<hex>`), retried with backoff, each with a unique `eventId`: `booking.created`, `booking.confirmed`, `booking.rescheduled`, `booking.cancelled`, `booking.no_show`, `booking.completed`, `order.created`, `order.accepted`, `order.fulfilled`, `order.cancelled`, `customer.created`, `payment.completed`. Inbound channel webhooks (WhatsApp, voice providers) are verified with the provider's signature before any processing.

## 9. Config pack shape (`@qenbel/config-packs`)

A pack is typed data validated by a zod schema in `@qenbel/shared`: `id`, `version`, `label`, `terminology` (UI words), `bookingMode` (`slot` | `table` | `room` | `period` | `none`), `orderMode` (`catalogue` | `dine_in` | `quote` | `rental` | `none`), `resourceTypes[]`, `requiredCustomerFields[]`, `bookingTransitions`, `orderTransitions`, `notificationTemplates`, `aiTools` (allow-list), `dashboard` (widgets), `defaults` (hours, hold minutes, cancellation policy). Adding a pack adds a file and a registry entry, no core change.

## 10. Non-goals for now

Payment gateway integration (ledger only), inventory automation, advanced analytics, automated provisioning of isolated stacks (a documented manual template first).
