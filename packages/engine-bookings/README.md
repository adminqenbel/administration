# @qenbel/engine-bookings

Booking domain logic for QenBel Administration: availability, holds, confirmation, rescheduling, cancellation policy, the booking lifecycle and hold expiry. Plain TypeScript functions, no Nest decorators.

Every function has the shape `(sql, ctx, input, options?)`:

- `sql` is a `SqlClient` already inside `withTenant(pool, tenantId, ...)`. The engine never opens connections and reads no environment.
- `ctx` is an `EngineContext` (`tenantId` from the authenticated principal, `actor`, `now()`, `newId()`, optional `idempotencyKey`).
- `input` is validated by a strict zod schema. `tenantId`, `role` or any unknown key gives `VALIDATION_FAILED`.
- `options` is `{ pack?, availability? }`. The API can pass its cached pack; `availability` swaps the private SQL reader for another loader (for example the catalogue engine's).
- Failures throw `AppError` with codes from `@qenbel/shared`.

The first thing each function does is check that the connection's `app.tenant_id` equals `ctx.tenantId` (otherwise `TENANT_REQUIRED`). All queries also filter on `tenant_id`; Row-Level Security is the second wall.

## Functions

| Function | Input | Result |
| --- | --- | --- |
| `checkAvailability` | shared `availabilityQuerySchema` (`from`, `to`, `catalogueItemId`, `resourceId`, `durationMinutes`, `partySize`) | `{ timezone, slots[], resources[] }` times and resource names only |
| `createHold` | `startsAt`, `endsAt` or `durationMinutes` or a service, `resourceId` or `resourceIds` (several at once) or none, `customerId`, `partySize`, `notes` | `{ booking, replayed }` in state `HOLD` |
| `confirmBooking` | `bookingId`, `customerId` or `customer`, `notes?`, `expectedVersion?` | `{ booking, replayed }` |
| `rescheduleBooking` | `bookingId`, `startsAt`, `endsAt` or `durationMinutes`, `resourceId?`, `expectedVersion` | `{ booking, replayed }` |
| `cancelBooking` | `bookingId`, `reason?`, `expectedVersion?` | `{ booking, cancellation, replayed }` |
| `checkIn`, `complete`, `markNoShow` | `bookingId`, `expectedVersion` | `{ booking, replayed }` |
| `transitionBooking` | `bookingId`, `to` (`CHECKED_IN`, `COMPLETED`, `NO_SHOW`), `expectedVersion` | dashboard dispatcher over the three above |
| `getBooking` | `bookingId` | `BookingView` |
| `listBookings` | `status`, `from`, `to`, `date`, `resourceId`, `customerId`, `channel`, `limit`, `cursor` | `{ items, nextCursor }`, ordered by start then id |
| `listBookingEvents` | `bookingId` | history from `audit_log` |
| `expireHolds` | `{}` | `{ expired, bookingIds }` |

## How double booking is prevented

The database decides. `createHold` locks the resource rows in id order, checks hours, then inserts the booking and allocation rows in id order. The exclusion constraint (exclusive resources) or the capacity trigger (shared resources) raises SQLSTATE `23P01`, which becomes `BOOKING_SLOT_TAKEN`. Each attempt runs in a savepoint, so a failed attempt leaves nothing behind even if the caller commits. With no resource named, the engine tries eligible resources in name order and takes the first that is free.

An exclusive resource is occupied through its cleanup buffer: the allocation period is `[startsAt, endsAt + buffer)`, so the database enforces the buffer for every caller. `bookings.ends_at` is the service end only. Buffer is the larger of the service's `buffer_minutes` and the pack default. A shared resource is occupied for the service time only, with `units = partySize` (default 1).

## State machine

Transitions go through `assertTransition` on the pack's machine (`machineForPack`: the default machine narrowed by `pack.bookingTransitions`). `confirm` is `HOLD -> CONFIRMED` only; `CONFIRMED -> CONFIRMED` is reschedule only. A removed edge gives `INVALID_TRANSITION` with `from`, `to` and `allowed`. `confirmBooking` on an expired hold gives `HOLD_EXPIRED`. A stale `expectedVersion` gives `VERSION_CONFLICT` with `expectedVersion` and `currentVersion`. Rows are locked `FOR UPDATE` first, so concurrent changes queue and the loser sees the new version. No-show is refused before the booking starts (`CONFLICT`, `reason: not_started`).

## Rules for bookable windows

A hold or reschedule must lie inside opening hours (location hours, intersected with the resource's own schedule, holiday closures or special hours, breaks, time off). It uses the same `generateSlots` code as availability. Failures are `BOOKING_SLOT_TAKEN` with `details.reason`: `taken`, `no_resource`, `outside_hours`, `in_the_past`, `lead_time`, `too_far_ahead`. Lead time and maximum advance apply to customer channels only (any channel except `dashboard`). The past is refused for everyone.

## Hold expiry

`hold_expires_at` is `ctx.now() + holdMinutes` (tenant setting, else pack). Three layers: the insert trigger releases an expired hold that blocks a new booking; `expireHolds` calls `expire_booking_holds_for_current_tenant` and audits each hold; the cross-tenant job uses `expireBookingHolds` from `@qenbel/db`. Confirm past expiry throws `HOLD_EXPIRED`; the throw rolls the transaction back, so the row itself is marked `EXPIRED` by the sweep, not by confirm.

## Cancellation policy

Policy is snapshotted into `bookings.policy_snapshot` at confirmation (`cancelUntilHoursBefore`, `lateCancellation`, `lateFeePaise`, `forfeitDepositOnLate`, `depositPaise`, pack id and version). Cancel uses the snapshot, falling back to today's rules for a `HOLD`.

- A `HOLD` cancels free.
- Outside the window: `free`.
- Inside it: `allow` gives `late_allowed`, no fee. `flag` gives `late_flagged`, fee = `lateFeePaise`, else the deposit when forfeited. `block` refuses customer channels with `FORBIDDEN` (`late_cancellation_blocked`); on the dashboard it is treated as `flag`.
- `depositRefundPaise` is the paid deposit minus the fee. The outcome is stored under `policy.cancellation`. No ledger rows are written here.

Reschedule inside the window: `block` refuses customer channels; otherwise it is recorded as `policy.lastRescheduleLate`.

## Tenant settings read from `tenants.settings.bookings`

All optional, strict, invalid values give `PACK_INVALID`: `holdMinutes`, `leadTimeMinutes` (default 0), `maxAdvanceDays` (default 90), `stepMinutes`, `breaks[]`, `cancellationPolicy { cancelUntilHoursBefore, lateCancellation, lateFeePaise, forfeitDepositOnLate }`, `deposit { percentBps | fixedPaise }`. A service can set `catalogue_items.attributes.depositPaise`.

## Data the schema does not model yet

No tables exist for staff time off, daily breaks or which services a resource can do. Until the db agent adds them (see `docs/CONTRACT-REQUESTS.md`), `src/sql-source.ts` reads `resources.attributes`: `serviceIds`, `breaks`, `timeOff`. Unreadable values make the resource unavailable (fail closed). If a location has no `business_hours` rows, the pack's default hours apply.

## Idempotency, events, audit

- With `ctx.idempotencyKey`, write functions use `idempotency_keys` (route `engine-bookings:<function>`) in the same transaction. Same key and input returns the stored result with `replayed: true` and writes nothing; different input is `IDEMPOTENCY_CONFLICT`. A call that fails leaves no key, so it can be retried.
- Outbox rows (`booking.created` on hold, `.confirmed`, `.rescheduled`, `.cancelled`, `.no_show`, `.completed`, and `customer.created` when confirm creates a customer) are written on the caller's transaction: once, and only on commit. Payloads carry ids, times and status, no free text.
- Every change writes an `audit_log` row (`booking.hold`, `.confirm`, `.reschedule`, `.cancel`, `.check_in`, `.complete`, `.no_show`, `.expire`) with actor kind, actor id and channel. `listBookingEvents` reads them back.

## Tests

`npm test -w @qenbel/engine-bookings` runs `node --test --test-concurrency=1` against the Docker Postgres test database (port 54329). It fails with instructions if the database is unreachable; nothing is skipped. This package never truncates the shared test database; each test makes its own tenants.

`npm run check -w @qenbel/engine-bookings` typechecks.
