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

The database decides. `createHold` locks the resource rows in id order, expires due holds on them, checks hours, then inserts the booking and allocation rows in id order. The exclusion constraint (exclusive resources) or the capacity trigger (shared resources) raises SQLSTATE `23P01`, which becomes `BOOKING_SLOT_TAKEN`. Each attempt runs in a savepoint, so a failed attempt leaves nothing behind even if the caller commits. With no resource named, the engine tries eligible resources in name order and takes the first that is free.

An exclusive resource is occupied through its cleanup buffer: the allocation period is `[startsAt, endsAt + buffer)`, so the database enforces the buffer for every caller. `bookings.ends_at` is the service end only. Buffer is the larger of the service's `buffer_minutes` and the pack default. A shared resource is occupied for the service time only, with `units = partySize` (default 1).

## State machine

Transitions go through `assertTransition` on the pack's machine (`machineForPack`: the default machine narrowed by `pack.bookingTransitions`). `confirm` is `HOLD -> CONFIRMED` only; `CONFIRMED -> CONFIRMED` is reschedule only. A removed edge gives `INVALID_TRANSITION` with `from`, `to` and `allowed`. `confirmBooking` on an expired hold gives `HOLD_EXPIRED`. A stale `expectedVersion` gives `VERSION_CONFLICT` with `expectedVersion` and `currentVersion`. Rows are locked `FOR UPDATE` first, so concurrent changes queue and the loser sees the new version. No-show is refused before the booking starts (`CONFLICT`, `reason: not_started`).

## Rules for bookable windows

A hold or reschedule must lie inside opening hours (location hours, intersected with the resource's own schedule, holiday closures or special hours, breaks, time off). It uses the same `generateSlots` code as availability. Failures are `BOOKING_SLOT_TAKEN` with `details.reason`: `taken`, `no_resource`, `outside_hours`, `in_the_past`, `lead_time`, `too_far_ahead`. Lead time and maximum advance apply to customer channels only (any channel except `dashboard`). The past is refused for everyone.

## Lock order

Every multi-statement flow takes locks in the order the database uses in the allocation insert trigger and both hold sweeps (migration 016): **resource rows (ascending id) -> booking rows (ascending id) -> booking_allocations**.

- `createHold`: `lockResources`, then `expireDueHolds` (locks the due HOLD bookings in id order, expires them), then the new booking and allocations (id order).
- `expireHolds`: locks the resources of the due holds, then the due bookings, then updates; the status change releases the allocations through `bookings_sync_allocations`.
- `rescheduleBooking`: reads the booking's allocations without a lock, locks the old and new resources, only then locks the booking, and re-reads the allocations. If they changed in between it throws `VERSION_CONFLICT` (`details.reason: allocation_changed`, nothing written; retry).
- `confirmBooking`, `cancelBooking`, check-in/complete/no-show: lock the booking, then the status/`expires_at` change reaches the allocations through the sync trigger. They never lock a resource afterwards (releasing an allocation does not take the resource lock), so they cannot invert the order.

`test/hold-locks.test.ts` races `expireHolds`, `createHold`, `confirmBooking`, `cancelBooking` and `rescheduleBooking` on one resource and fails on any `SERVICE_UNAVAILABLE` (the mapping of 40P01/40001). The engine still maps those codes to a retry.

## Hold expiry

`hold_expires_at` is `ctx.now() + holdMinutes` (tenant setting, else pack). Three layers: `createHold` and `rescheduleBooking` expire due holds on the resources they lock (so the allocation trigger finds nothing left to release); `expireHolds` expires every due hold of the tenant and then calls `expire_booking_holds_for_current_tenant` for stray allocations; the cross-tenant job `expireBookingHolds` from `@qenbel/db` exists but writes no audit or outbox rows, so a worker that wants `booking.expired` events should call `expireHolds` per tenant. Each hold the engine expires gets one `audit_log` row (`booking.expire`) and one `booking.expired` outbox event, in the same transaction, exactly once (the HOLD to EXPIRED update only matches a row still in HOLD, under its row lock). Payload: the usual booking payload with `status: EXPIRED`, `previousStatus: HOLD` and `reason` (`hold_expired` from the sweep, `slot_requested` when a new hold or reschedule cleared it). Expiry is judged by `ctx.now()` in `expireHolds` and by the database clock in `createHold`/`rescheduleBooking` (the same clock the trigger uses). Confirm past expiry throws `HOLD_EXPIRED`; the throw rolls the transaction back, so the row itself is marked `EXPIRED` by the sweep, not by confirm.

## Cancellation policy

Policy is snapshotted into `bookings.policy_snapshot` at confirmation (`cancelUntilHoursBefore`, `lateCancellation`, `lateFeePaise`, `forfeitDepositOnLate`, `depositPaise`, pack id and version). Cancel uses the snapshot, falling back to today's rules for a `HOLD`.

- A `HOLD` cancels free.
- Outside the window: `free`.
- Inside it: `allow` gives `late_allowed`, no fee. `flag` gives `late_flagged`, fee = `lateFeePaise`, else the deposit when forfeited. `block` refuses customer channels with `FORBIDDEN` (`late_cancellation_blocked`); on the dashboard it is treated as `flag`.
- `depositRefundPaise` is the paid deposit minus the fee. The outcome is stored under `policy.cancellation`. No ledger rows are written here.

Reschedule inside the window: `block` refuses customer channels; otherwise it is recorded as `policy.lastRescheduleLate`.

## Tenant settings read from `tenants.settings.bookings`

All optional, strict, invalid values give `PACK_INVALID`: `holdMinutes`, `leadTimeMinutes` (default 0), `maxAdvanceDays` (default 90), `stepMinutes`, `breaks[]`, `cancellationPolicy { cancelUntilHoursBefore, lateCancellation, lateFeePaise, forfeitDepositOnLate }`, `deposit { percentBps | fixedPaise }`. A service can set `catalogue_items.attributes.depositPaise`.

## Resource availability data

`src/sql-source.ts` reads the tables from migration 013 (the old `resources.attributes.{timeOff,breaks,serviceIds}` keys are not read or written):

- `resource_time_off(resource_id, starts_at, ends_at)`: blocked `[starts_at, ends_at)`; only rows overlapping the requested window are loaded.
- `resource_breaks(resource_id, weekday 0=Sunday..6, start_time, end_time)`: recurring breaks in the location's time zone. A resource with no rows uses the tenant/pack `breaks`; a resource with any row uses only its own rows, per weekday (a weekday without a row has no break).
- `resource_services(resource_id, catalogue_item_id)`: a resource with no rows can serve any service (of the matching `required_resource_type`); rows narrow it to exactly those services (`details.reason: service` / `resource_not_eligible`).

Rows that cannot be understood (a break with seconds, an open-ended `infinity` time off) make the resource unavailable (fail closed). If a location has no `business_hours` rows, the pack's default hours apply.

## Idempotency, events, audit

- With `ctx.idempotencyKey`, write functions use `idempotency_keys` (route `engine-bookings:<function>`) in the same transaction. Same key and input returns the stored result with `replayed: true` and writes nothing; different input is `IDEMPOTENCY_CONFLICT`. A call that fails leaves no key, so it can be retried.
- Outbox rows (`booking.created` when the HOLD is created (not at confirm, so a hold that expires has created and expired events but no confirmed one), `.confirmed`, `.rescheduled`, `.cancelled`, `.no_show`, `.completed`, `.expired` (once per expired hold), and `customer.created` when confirm creates a customer) are written on the caller's transaction: once, and only on commit. Payloads carry ids, times and status, no free text.
- Every change writes an `audit_log` row (`booking.hold`, `.confirm`, `.reschedule`, `.cancel`, `.check_in`, `.complete`, `.no_show`, `.expire`) with actor kind, actor id and channel. `listBookingEvents` reads them back.

## Tests

`npm test -w @qenbel/engine-bookings` runs `node --test --test-concurrency=1` against the Docker Postgres test database (port 54329). It fails with instructions if the database is unreachable; nothing is skipped. This package never truncates the shared test database; each test makes its own tenants.

`npm run check -w @qenbel/engine-bookings` typechecks.
