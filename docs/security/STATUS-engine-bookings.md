# Security status: engine-bookings

Findings from `docs/security/REVIEW-stage2.md` owned by (or touching) `packages/engine-bookings`. Date: 2026-11-07.
Regression tests: `packages/engine-bookings/test/security.test.ts` (mirrors the PoCs in `docs/security/poc/engine-abuse.test.ts`).
Design notes: `packages/engine-bookings/README.md`, section "Customer channels: ownership and limits"; code in `src/access.ts`.

Customer channels = `web_chat`, `whatsapp`, `voice`. `dashboard` (staff) and `api` (trusted server integration) are not
ownership-restricted. The end customer is identified only by `ctx.subject` (`customerId`, `conversationId`), set by the channel layer.

| ID | Status | What changed | Test |
| --- | --- | --- | --- |
| SEC-008 no ownership | Fixed | confirm, reschedule, cancel, getBooking require the subject to own the booking (verified customer, or same conversation and not another verified customer's). Missing subject, foreign or anonymous booking: `NOT_FOUND` with the same body as an unknown id. Ownership checked before any row lock. `listBookings` scoped to the subject (25/page). `listBookingEvents` NOT_FOUND; check-in/complete/no-show/transition/expireHolds FORBIDDEN on customer channels. Holds store `conversation_id` (and `customer_id` when verified); an anonymous hold can be confirmed only from its conversation. A customer channel cannot attach another customer's id. | "SEC-008 ownership" suite (5 tests) |
| SEC-004 unlimited holds | Fixed | Live-hold limits per conversation (2), verified customer (5), credential (20), tenant (100, customer-channel holds); active-booking limits per conversation (4) and customer (10); all in `tenants.settings.bookings.limits`. Atomic via sorted transaction advisory locks before any row lock. Unverified holds last at most 10 minutes. `RATE_LIMITED` with `reason`/`scope`. | PoC 30 sequential -> 2; 20 parallel from one conversation -> 2; customer, credential, tenant, expiry, active-booking tests |
| SEC-005 customer-chosen duration | Fixed | Customer channels must give `catalogueItemId`; `durationMinutes`/`endsAt` refused on hold and reschedule; at most 3 resources per hold. Shared-resource party size above capacity was already refused (`resource_not_eligible`). | "SEC-005" suite (2 tests) |
| SEC-010 idempotency principal | Fixed (engine side) | Engine idempotency route includes a principal tag (actor kind, id, channel, conversation, customer); with migration 018's `app.principal` binding a second principal's same key is a plain miss. | "PoC: another credential repeating a key" |
| SEC-009 e-mail oracle on confirm | Fixed | Customer channels match by phone only and drop an e-mail that is already taken (no 23505, no oracle); staff channels match phone then e-mail; a 23505 race on phone reuses the record. | "a customer-channel confirm with someone else's e-mail" |
| Lock contention via guessed ids | Fixed | Unlocked ownership check before `FOR UPDATE` on customer channels. | "a foreign id never waits on a row lock" |
| Pagination caps | Fixed | Customer channels: at most 25 per page and only own bookings; staff max stays 100. | covered in the SEC-008 PoC test |
| Enumeration via errors | Fixed for bookings | Foreign and unknown ids give identical NOT_FOUND bodies; version and state errors only after ownership passes. | SEC-008 PoC compares bodies call by call |
| SEC-020 phone claim on unverified channels | Open (product decision) | An anonymous web-chat confirm whose phone matches an existing customer still attaches the booking to that customer (nothing is revealed or changed on the record). Options: separate pending customer merged by staff, or a confirmation message to the number first. | - |
| SEC-014 per-conversation caps | Done for bookings | Covered by the limits above; agent-runtime caps are Stage 4. | - |

## Open questions

1. The `api` channel is trusted (no ownership, no limits, may set a duration). If some API credentials act for end customers, they should come in as a customer channel, or we add a per-credential "customer-facing" flag.
2. The active-bookings limit at confirm for an anonymous session whose phone matches an existing customer is checked without that customer's advisory key (best effort; the conversation limit still binds).
3. The per-tenant ceiling serialises every customer-channel hold of a tenant on one advisory lock for the length of the hold transaction. Fine for single-shop volumes; revisit if a tenant needs high hold throughput.
4. A widget visitor without a conversation id cannot hold at all. The channel layer must create the `conversations` row before the first hold.
