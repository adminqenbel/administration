# @qenbel/engine-catalog

Customers/CRM, catalogue, resources and schedules, locations, business hours, holidays, and the availability-input
loader. Plain TypeScript functions, no framework.

```ts
fn(sql: SqlClient, ctx: EngineContext, input) => Promise<result>
```

Rules every function follows:

- The caller runs it inside `withTenant(pool, ctx.tenantId, (sql) => fn(sql, ctx, input))`. The tenant comes from `ctx` only.
  Every query also filters `tenant_id = ctx.tenantId`, on top of Row-Level Security.
- Input is validated with strict zod schemas. A smuggled `tenantId`, `tenant_id`, `role` or any unknown key fails with
  `VALIDATION_FAILED` before any SQL runs. A `ctx` with no valid tenant id fails with `TENANT_REQUIRED`.
- Errors are `AppError`. Postgres errors are translated (unique violation to `CONFLICT`, check or cast to `VALIDATION_FAILED`,
  the db trigger `55000` to `CONFLICT`); the database message is never copied out. Missing or foreign ids are `NOT_FOUND`.
- Money is integer paise (a decimal or string is refused); tax is basis points.
- Lists page with `{ items, nextCursor }`, `limit` 1 to 100 (default 25) and an opaque `cursor`. Cursors carry values only,
  which reach SQL as parameters; a malformed cursor is `VALIDATION_FAILED`.
- **Channels (security review SEC-006).** Same split as engine-bookings and engine-orders: `web_chat`, `whatsapp`, `voice`
  are customer channels; `dashboard` and `api` are trusted (the API enforces their permissions). A value outside the
  `Channel` enum is treated as a customer channel. Every function is staff-only (`staffOp`: `FORBIDDEN`,
  `details.reason = "CHANNEL_NOT_ALLOWED"`, before input validation or SQL, so an id probe learns nothing) except these six:
  `searchCustomersForAi`, `getCatalogueForChannel`, `getBusinessProfileForChannel`, `loadAvailabilityInputs`,
  `createFollowUp`, `logCommunication`. A test walks every export and fails if a new one is not classified.
  - `searchCustomersForAi` on a customer channel is not a lookup: it only confirms `ctx.subject.customerId` (set by the
    channel layer from the verified contact). All given filters must match that one record and the only possible result
    is its own minimal summary. No subject (or a malformed one), archived subject, other tenant, or a miss: the same
    `{ customers: [] }`, and with no subject no SQL runs. On trusted channels it is the tenant-wide minimal lookup.
  - `createFollowUp` / `logCommunication` on a customer channel need a subject; `customerId`, `bookingId`, `orderId` and
    `conversationId` must belong to it (else `NOT_FOUND`); the follow-up is always `ai_escalation` about the subject, cannot
    assign staff or set a due time, and a repeat within 30 minutes (database clock) returns the open task (SEC-014).
- Postgres constraint names are never put in error `details` (SEC-022); the contact unique indexes give `details.field`.
- `attributes` keys must match `^[A-Za-z][A-Za-z0-9_]{0,39}$` with scalar values; an own `__proto__` key (as `JSON.parse`
  makes) is dropped by the schema and never stored. There is no deep merge.
- Only `createCustomer` emits an event (`customer.created`, once, only when a row is created, payload with masked contact).
  The webhook list has no other event for this package. Audit log rows are the API layer's job.

## What is here

| Area | Functions |
| --- | --- |
| Customers | `createCustomer` (dedupe), `updateCustomer`, `archiveCustomer`, `restoreCustomer`, `getCustomer`, `searchCustomers` (staff, full), `searchCustomersForAi` (minimal, masked), `addCustomerTag`, `removeCustomerTag`, `listTags` |
| CRM | `addCustomerNote`, `listCustomerNotes`, `createFollowUp`, `getFollowUp`, `updateFollowUp`, `setFollowUpStatus`, `listFollowUps`, `logCommunication`, `listCommunications`, `getCustomerTimeline`, `getCustomerBalance` |
| Catalogue | `createCatalogueItem`, `updateCatalogueItem`, `archiveCatalogueItem`, `restoreCatalogueItem`, `getCatalogueItem`, `listCatalogueItems`, `createVariant`, `updateVariant`, `listVariants`, `createCategory`, `updateCategory`, `listCategories`, `deleteCategory`, `getCatalogueForChannel` (AI-safe) |
| Business | `getBusinessProfile`, `getBusinessProfileForChannel` (AI-safe), `updateBusinessProfile`, `createLocation`, `updateLocation`, `getLocation`, `listLocations`, `archiveLocation`, `restoreLocation`, `getLocationHours`, `setLocationHours`, `createHoliday`, `updateHoliday`, `deleteHoliday`, `listHolidays` |
| Resources | `createResource`, `updateResource`, `getResource`, `listResources`, `archiveResource`, `restoreResource`, `getResourceSchedule`, `setResourceSchedule`, `setResourceBreaks`, `getResourceBreaks`, `addResourceTimeOff`, `removeResourceTimeOff`, `listResourceTimeOff`, `setResourceServices`, `listResourcesForService` (`loadWeeklyBreaks` is an internal set-based reader) |
| Availability | `loadAvailabilityInputs` plus pure helpers `slotRequestFor`, `generateResourceSlots`, `generateAllSlots`, `peakUnits`, `intersectIntervals` |
| Pure helpers | `normalisePhone`, `normaliseEmail`, `maskPhone`, `maskEmail`, `breaksOf` |

### Behaviour worth knowing

- **Dedupe (R4.2).** `createCustomer` matches active (not archived) customers by normalised phone (E.164) or lower-cased email and
  returns `{ customer, created: false, matchedBy }` without writing. If the phone matches one customer and the email another it
  throws `CONFLICT` with `details.candidates`. Concurrent creates are serialised with advisory locks. Archived customers are
  not matched; restoring one whose phone or email is now taken is `CONFLICT`. `updateCustomer` onto someone else's phone or
  email is `CONFLICT` naming that customer (`details.field`, `customerId`, `candidates`).
- **Database backstop (migration 014).** The database also enforces one active customer per tenant per phone and per
  `lower(email)` (`customers_active_phone_unique`, `customers_active_email_unique`, SQLSTATE 23505). The engine keeps its
  lookup and advisory locks, so the constraint only fires when some other writer (without the locks) wins a race. Each
  write that can hit it runs in a savepoint, so the transaction stays usable: `createCustomer` then re-reads and answers as
  a dedupe (`created: false`, the winner), or `CONFLICT` with `details.candidates` if that is ambiguous; `updateCustomer`
  and `restoreCustomer` throw `CONFLICT` with `details.field` (`phone` | `email`), `customerId` and `candidates`. Any other
  engine call that meets those two constraints maps to `CONFLICT` with `details.field` and no database text.
- **Phone.** `normalisePhone` accepts `+`/`00` international numbers and, for India, bare 10 digit mobiles (6-9), with `0` or `91`
  in front. Anything it cannot place safely is refused, not guessed.
- **AI-safe reads.** `searchCustomersForAi`: id, first name, masked phone and email, `hasUpcomingBooking`, at most 5, needs a filter (customer channels: the subject only, see above).
  `getCatalogueForChannel`: id, name, kind, description (cut at 1000), category name, price, currency, duration, available, active
  variants; never archived items, inactive categories, SKU, tax, buffer, attributes. `getBusinessProfileForChannel`: only
  whitelisted settings keys and active locations.
- **Archive, not delete.** Customers, catalogue items, resources and locations are archived and can be restored. Archiving a
  resource or location with upcoming bookings is `CONFLICT` with the count (R6.4). Archive is idempotent.
- **R6.5.** `addResourceTimeOff` and a shorter `setResourceSchedule` are refused with `details.affectedBookings` when live
  bookings or holds would be hit. An all-empty schedule removes it (the resource then follows the location's hours).
- **Breaks.** A break in the location's weekly hours is the gap between two intervals on a day. A resource's own breaks are
  rows in `resource_breaks` (`weekday` 0 = Sunday, local time, one row per weekday). `setResourceBreaks({ resourceId, breaks })`
  is the daily form (the same on every day: a break writes seven rows); `setResourceBreaks({ resourceId, weekly })` sets a
  pattern per weekday. Both replace the whole set; an empty list removes it. `getResourceBreaks` returns `breaks` (those
  that apply on all seven days), `weekly` and `hasBreaks` (the resource has rows).
- **Time off.** Rows in `resource_time_off`, half-open `[startsAt, endsAt)`: an entry overlaps a window when
  `starts_at < windowEnd and ends_at > windowStart`, so touching edges do not overlap. Entries may overlap each other; an
  exact duplicate is `CONFLICT`. `reason` up to 500 characters. `createdByUserId` is filled only when the actor is a user
  of this tenant. At most 500 per resource.
- **Service links.** Rows in `resource_services`. A resource with rows serves exactly those services; a resource without
  rows serves services whose `required_resource_type` is unset or equal to the resource type (`ELIGIBLE_SQL`).
- **`attributes` is just a bag.** `resources.attributes` holds scalar keys only (string, number, boolean). `timeOff`,
  `breaks` and `serviceIds` used to be reserved for interim storage; they are now ordinary keys with no meaning to the
  engine (a string under `timeOff` changes nothing), and the array/object values the old storage used are refused like any
  non-scalar value. The engine never reads or writes them. Rows an older version of the engine left in those keys were
  moved by migration 013 (`app_move_resource_extras()`).

## `loadAvailabilityInputs`

```ts
loadAvailabilityInputs(sql, ctx, {
  locationId,                  // required, must be an active location of this tenant
  serviceId?, variantId?,      // a service (duration and buffer from the item; variant duration overrides)
  durationMinutes?, bufferMinutes?, // OR, without serviceId (tables, rooms): the length to book
  resourceIds?, resourceType?, // narrow the candidates
  partySize?,                  // tables: capacity_units >= party and (shared or min_units <= party)
  from, to?,                   // local dates YYYY-MM-DD in the location's zone, at most 31 days
  excludeBookingId?,           // reschedule: ignore this booking's own allocations
}) => AvailabilityInputs
```

Needs `serviceId`, or `durationMinutes`; not both. A constant number of queries (9 with a service, none per resource: location,
service, resources, location hours, holidays, schedules, breaks, time off, allocations) however many resources there are; a test
asserts the count is the same for 2 and 27 resources.

```ts
interface AvailabilityInputs {
  timezone: string;                       // location IANA zone
  locationId: string;
  from: string; to: string;               // local dates, inclusive
  window: { start: string; end: string }; // UTC instants covering from 00:00 local to the end of `to` (end exclusive)
  service: { id: string|null; name: string|null; variantId: string|null; durationMinutes: number; bufferMinutes: number };
  resources: Array<{
    resourceId: string; name: string; type: string;
    allocationMode: "exclusive" | "shared"; capacityUnits: number; minUnits: number;
    hours: WeeklyHours;                    // shared WeeklyHours: location hours intersected with the resource schedule
    dateOverrides: Record<string, TimeInterval[]>; // local date -> that day's intervals, where it differs from `hours`
                                                   // (special-hours holidays, dated schedule rows)
    breaks: Record<Weekday, TimeInterval[]>; // the resource's own breaks per local weekday (resource_breaks)
    hasOwnBreaks: boolean;                 // true when the resource has break rows (false: use your default breaks)
    holidays: string[];                    // closed local dates (location holiday or all-location holiday)
    timeOff: TimeRange[];                  // resource_time_off overlapping the window, UTC
    allocations: Array<{ start: string; end: string; units: number }>; // active, unexpired; ISO UTC
  }>;
}
```

`resources` only holds candidates that qualify: not archived, active, at this location (or with no location), eligible for the
service, in `resourceIds`, big enough for `partySize`. Expired holds and cancelled bookings are not in `allocations`.
Allocations within the service buffer of the window edges are included.

The raw fields are what `generateSlots` takes (`hours`, `holidays`, `allocations`, `durationMinutes`, `bufferMinutes`); `breaks`
is per weekday here and `slotRequestFor` passes the date's weekday list as `generateSlots`' daily `breaks`. Three things `generateSlots` does not know are handled by the helpers, so use them rather than calling it directly:

1. **Time off** is subtracted after generation.
2. **Date overrides** (special-hours holidays, dated schedule rows) replace that weekday's intervals for one date.
3. **Shared resources**: allocations do not block each other, so `slotRequestFor` passes none and `generateResourceSlots` keeps
   a slot only if `peakUnits + units <= capacityUnits` (`units` defaults to 1).

```ts
const inputs = await loadAvailabilityInputs(sql, ctx, { locationId, serviceId, from, to });
for (const r of inputs.resources) {
  for (const date of eachLocalDate(inputs.from, inputs.to)) {
    const slots = generateResourceSlots(inputs, r, date, { notBefore, stepMinutes, units });
  }
}
// or: generateAllSlots(inputs, { notBefore, stepMinutes })  -> sorted by start then resource name
```

This is decision support only; the booking write still relies on the database exclusion constraint and capacity trigger.
Call `expire_booking_holds_for_current_tenant()` first if you want stale holds swept; the loader already ignores expired holds.

## Tests

`npm test -w @qenbel/engine-catalog` runs `node --test` against the Docker Postgres test database (`qenbel_admin_test`), and fails
with instructions if it is unreachable. It does not truncate: every test creates fresh tenants and deletes them afterwards, so
it can run beside other packages' tests. `npm run check -w @qenbel/engine-catalog` typechecks.
