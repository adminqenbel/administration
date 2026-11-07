# engine-orders: status of the Stage 2 security findings

Date: 2026-11-07. Scope: `packages/engine-orders` only. Details: `packages/engine-orders/README.md`, section
"Customer channels: ownership and limits". Regression tests: `packages/engine-orders/test/customer-channels.test.ts`.

| Finding | Status | What changed |
| --- | --- | --- |
| SEC-007 (High) order ownership fail-open | Fixed | `onBehalfOfCustomerId` removed from all inputs. Ownership comes only from `ctx.subject.customerId` (set by the channel layer). On `web_chat`, `whatsapp`, `voice`: `placeOrder`, `cancelOrder`, `getOrder`, `getOrderStatusForChannel` act only on the subject's order; no subject, a foreign order, an order with no customer and a missing order give one identical `NOT_FOUND` body (test compares the bodies). Ownership is checked before the row lock. Staff operations, discounts, payments, refunds, payment lists and the board are `FORBIDDEN` on these channels. `capOverride` only from `dashboard`. The PoC `[DEFECT SEC-007]` in `poc/engine-abuse.test.ts` now passes; its `todo` can be removed. |
| SEC-010 (Medium) idempotency not bound to principal | Fixed (engine part) | Engine idempotency route is `engine:orders:<function>:<principal tag>` (actor kind, id, channel, subject customer, conversation), on top of the database's `app.principal` binding (migration 018). Another principal repeating key and body is a plain miss, never a replay or an `IDEMPOTENCY_CONFLICT`. |
| SEC-009 (Low) raw 23505 on inline customer | Fixed (orders part) | Inline customer (staff placement only) is matched by phone, then e-mail (any case); the insert runs in a savepoint and a 23505 race is re-looked-up, else a neutral `VALIDATION_FAILED`. Customer channels cannot create or swap the customer at all. |
| SEC-020 (Low) claiming a phone number | Fixed for orders | Customer channels can no longer attach an order to a customer by phone; the customer is the verified subject. |
| SEC-022 (Low) constraint names in error details | Fixed | `mapPgError` no longer copies `constraint` into `details`. |
| Size limits (related to SEC-004/014) | Added | Customer channels: 50 lines, 99 per line, 500 units, 20 drafts per customer per 24 h, list pages of 25. Staff and api: 100 lines, 999 per line, 5000 units, pages of 100. Board 50 cards per column; payment list 500 entries. |

Decision on the `api` channel: like engine-bookings, `api` is a trusted server integration acting for the tenant (its own
credential, permissions and tool scope are enforced by the API), so it is treated like staff and a subject on it is ignored.
It still cannot set `capOverride`.

Known effect on the PoC file: `[GUARD] with onBehalfOfCustomerId set, another customer's order looks absent` now fails
with `VALIDATION_FAILED`, because the field no longer exists. Replace it with a guard that sets `ctx.subject` instead.

Open: anonymous web chat cannot draft or place orders until the channel layer identifies the customer and sets the
subject (by design, fail closed). A cancelled paid order still writes an automatic refund ledger entry on a customer's own
cancel (record only, no money moves); say if that should need staff approval instead.
