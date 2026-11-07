# @qenbel/engine-orders

The order engine: drafts, pricing, tax and discounts, the pack-narrowed state machine, fulfilment, and the payments
ledger. Plain TypeScript functions, no HTTP and no Nest:

```ts
(sql: SqlClient, ctx: EngineContext, input) => Promise<result>
```

Call them inside `withTenant` from `@qenbel/db`. One call is one transaction: the API opens it, the engine writes the
change, the audit row and the outbox event in it, and the API commits. If anything throws, nothing is kept (no order
change, no event). The package imports `@qenbel/config-packs` only to find the tenant's pack.

```
npm run check -w @qenbel/engine-orders     # tsc
npm test -w @qenbel/engine-orders          # node --test against the Docker Postgres (fails, never skips, if it is down)
```

Tests use `TEST_DATABASE_URL` / `TEST_DATABASE_MIGRATE_URL`, or the docker-compose database on localhost:54329. Set
`ORDERS_TEST_DATABASE` to use another database name (default `qenbel_admin_test`). The tests never truncate: every file
creates fresh tenants with random slugs.

## Rules the engine enforces

- Tenant comes from `ctx.tenantId` only. Every function first checks that the SQL client is inside `withTenant` for that
  same tenant (`TENANT_REQUIRED` otherwise). Inputs are strict zod schemas: a `tenantId`, role, price, tax, total or status
  in any input is `VALIDATION_FAILED`. Every query also filters by `tenant_id` and runs under RLS.
- Prices are read from the catalogue on the server (`base_price_paise`, or the variant's `price_paise`) and snapshotted
  onto the line with the name. Clients and AI send only item ids, variant ids, quantities and notes. Later catalogue price
  changes never touch existing orders.
- Money is integer paise, BigInt-safe maths from `@qenbel/shared`. Rounding mode is explicit (`ORDER_ROUNDING_MODE` =
  `HALF_UP`) and tested.
- Optimistic `version`: staff actions carry `expectedVersion` (required for edits and steps; optional for `placeOrder` and
  `cancelOrder`, which the AI uses). The order row is locked `FOR UPDATE`, so concurrent callers queue; the loser sees
  `VERSION_CONFLICT` (`details.reason` `ORDER_VERSION_CONFLICT`, with `currentVersion`).
- Errors are `AppError`s from `@qenbel/shared`. `details.reason` carries a stable name matching the tool registry's
  (`ORDER_ITEM_UNAVAILABLE`, `ORDER_REQUIRED_FIELDS_MISSING`, `ORDER_VERSION_CONFLICT`, `ORDER_INVALID_STATE`,
  `ORDER_NOT_FOUND`, `OVERPAYMENT`, `REFUND_EXCEEDS_PAID`, `DISCOUNT_CAP_EXCEEDED`, ...), because the shared error code set
  has no order-specific codes yet.

## Totals

```
line net      = quantity * unit price
subtotal      = sum of line nets
discount      = fixed paise, or basis points of the subtotal (rounded with the mode); never above the subtotal
line discount = discount spread over lines by net, largest remainder (ties: earlier line); parts sum exactly
line tax      = tax_rate_bps of (line net - line discount), rounded with the mode
total         = subtotal - discount + tax            (matches the orders_total_consistent CHECK)
```

A discount reduces the taxable value (GST practice). Discounts above `DISCOUNT_APPROVAL_CAP_BPS` (20% of the subtotal)
need `capOverride: true`, which the API must set only for a principal with the override permission and never from a
customer or an AI tool call. The flag, the amount, the reason and the rounding mode go to `audit_log`.

### Discount persistence

`orders.discount_paise` is the amount taken off. HOW it was made is stored beside it: `discount_type` (`fixed` or
`percent_bps`, the `DiscountType` constants of `@qenbel/shared`), `discount_value` (paise, or basis points up to
10000), `discount_reason` and `discount_cap_override`. The input still says `kind: "fixed" | "percent"`; the engine maps
it. `OrderView.discount` returns `{ type, value, reason, capOverride }` (null when none).

- Every line change on a draft (`addItem`, `updateItem`, `removeItem`) RECOMPUTES `discount_paise` from the stored spec on
  the new subtotal (percent follows the subtotal; a fixed amount stays). Line and order tax are recomputed with it.
- The discount is removed (spec columns set to NULL, `notices: ["DISCOUNT_CLEARED"]`, audit `discountCleared: true`) only when
  the spec became invalid for the edited lines: a fixed amount larger than the new subtotal, or a discount that is now above
  `DISCOUNT_APPROVAL_CAP_BPS` (a fixed amount on a shrunken order) and was not approved with the override.
- `discount_cap_override` is true only when the override flag was actually needed when the discount was applied. An approved
  discount keeps covering its spec through later edits (it is still limited by the subtotal).
- A percent discount on an emptied draft stays on record with amount 0 and returns when a line is added. `removeDiscount`
  clears the spec.
- `placeOrder` does not recompute: it freezes what the draft holds.

### Tax rate per line

`order_items.tax_rate_bps` is copied from the catalogue when the line is inserted and frozen. Draft edits (quantity, note,
other lines, discount changes) never read the catalogue rate again, so a rate change in the catalogue cannot move an existing
line. The only way to pick up a new rate (or price) is to remove the line and add the item again. `addItem` merges into an
existing line only when item, variant, note, unit price AND frozen tax rate match; otherwise it starts a new line. There is no
"re-price line" function yet.

## Functions

| Group | Functions |
| --- | --- |
| Draft | `createOrderDraft` (idempotent on `ctx.idempotencyKey`), `addItem`, `updateItem`, `removeItem`, `updateOrderNotes`, `applyDiscount`, `removeDiscount`, `setFulfilment` |
| Lifecycle | `placeOrder`, `acceptOrder`, `startProcessing`, `markReady`, `fulfil`, `rejectOrder`, `cancelOrder`, `transitionOrder` |
| Ledger | `recordPayment`, `recordRefund`, `listPayments` |
| Reads | `getOrder`, `getOrderStatusForChannel`, `listOrders`, `getOrderBoard` |
| Pure | `computeTotals`, `derivePaymentStatus`, `netPaidPaise`, `outstandingPaise`, `machineForPack` |

Edits to lines, discount and notes are DRAFT only. Fulfilment (`pickup`, `delivery` with address, `dine_in` with a table
resource or label, `on_site`) and the optional `bookingId` link can change until preparation starts. The link is a
reference only: bookings and orders stay separate records and the engine never writes a booking.

`createOrderDraft` idempotency: the key row goes in `idempotency_keys` with route `engine:orders:createOrderDraft` (the API
uses its own routes, so there is no clash). A concurrent duplicate blocks on the unique index and then replays the first
result. Same key with a different input is `IDEMPOTENCY_CONFLICT`. `recordPayment` and `recordRefund` work the same way.

## State machine

The default machine is `DEFAULT_ORDER_TRANSITIONS` in `@qenbel/shared`. The engine narrows it with the tenant pack's
`orderTransitions` (pack id read from `tenants.pack_id`; `setPackResolver` lets the API plug in DB-stored packs). A tenant
with no pack, or `orderMode: "none"` (salon, clinic), cannot write orders.

- `placeOrder` (DRAFT to PLACED): at least one line, every line still available (prices are not refreshed), and the pack's
  `requiredCustomerFields` present on the customer: an existing `customerId`, an inline `customer` (found by phone, else
  email, else created, with `customer.created`), or the order's own customer. Otherwise `REQUIRED_FIELDS_MISSING` with
  `details.missing`. Ten-digit phone numbers are read as `+91`.
- `transitionOrder` is the generic dashboard move. `to: PLACED` goes through `placeOrder`.
- Cancelling or rejecting a paid order records a full refund ledger entry (method `refundMethod`, default `other`), so the
  order ends `CANCELLED`/`REJECTED` with `payment_status` `refunded`.
- `REFUNDED` is reachable only from FULFILLED, and only when the ledger is fully refunded.
- `onBehalfOfCustomerId` on `placeOrder` and `cancelOrder` is for customer-facing channels: the API sets it from the
  verified contact; an order of another customer then looks absent (`NOT_FOUND`) and the customer cannot be swapped.

## Payments ledger

Rows in `payments` are inserted, never changed (the app role cannot update amounts or delete; tests prove it). Every entry
locks the order row first, so concurrent payments and refunds serialise.

- `recordPayment`: only for PLACED to FULFILLED orders; amount must not exceed the outstanding balance
  (`OVERPAYMENT`, `details.outstandingPaise`).
- `recordRefund`: any non-draft order; amount must not exceed payments minus refunds (`REFUND_EXCEEDS_PAID`). A full refund of a
  FULFILLED order moves it to REFUNDED (version +1) if the pack allows it.
- `payment_status`: `unpaid` (nothing paid), `partial` (money held but less than the total, including after a partial
  refund), `paid` (held covers the total), `refunded` (paid, and all of it returned). Entries do not bump the order version.
- No gateway: entries record what staff received or returned.

## Events (outbox)

Written to `outbox_events` in the same transaction, with `ctx.newId()` as `event_id`. Payloads hold ids, status, version
and paise only; no names, phones or notes.

| Event | When |
| --- | --- |
| `order.created` | DRAFT to PLACED (drafts are scratch space and are not announced) |
| `order.accepted` | PLACED to ACCEPTED |
| `order.fulfilled` | READY to FULFILLED |
| `order.cancelled` | CANCELLED from a non-draft status (cancelling a draft sends nothing) |
| `order.rejected` | PLACED to REJECTED (staff declined) |
| `payment.completed` | every ledger entry of kind `payment` |
| `payment.refunded` | every ledger entry of kind `refund`: `recordRefund`, and the automatic refund when a paid order is cancelled or rejected |
| `customer.created` | inline customer created at placement |

Payloads carry `kind` (`payment` or `refund`) on the two payment events, and `status` / `previousStatus` on order events. PROCESSING, READY and REFUNDED send no order event. Every mutation also writes an `audit_log` row (`order.*`).

## AI and WhatsApp view

`getOrderStatusForChannel({ customerId, orderId | orderReference })` returns reference, status and its pack label, payment
status, lines (name, quantity, unit and line paise, line note), total, currency, version and updatedAt. Nothing else. The
`customerId` comes from the verified contact, not from the model. An order that is someone else's, has no customer, does
not exist, or only matches a prefix of the reference all give the identical `NOT_FOUND` body.

## Limits and notes

- 100 lines per order, 999 per line (identical item/variant/note/price lines merge), order total at most
  `MAX_ORDER_TOTAL_PAISE`, ledger entry at most `MAX_ENTRY_PAISE`.
- One currency per order (taken from the first item).
- The dine-in table is `orders.resource_id` (composite FK to `resources`, so another tenant's table is refused by the engine as
  `RESOURCE_NOT_FOUND` and by the database as 23503). It must be an active `table` resource. The fulfilment row keeps only the
  human label (`address.tableLabel`, defaulting to the resource name); a label-only dine-in or any other fulfilment type sets
  `resource_id` to NULL.
- Lists page by `(created_at desc, id desc)` with an opaque cursor; the board returns true counts per status.

Schema: migrations 012 (events) and 015 (order discount spec, `resource_id`, `tax_rate_bps`) are required. See
`docs/CONTRACT-REQUESTS.md` for open contract questions.
