# Security status: engine-catalog (Stage 2.7)

Scope: findings in `docs/security/REVIEW-stage2.md` owned by or touching `packages/engine-catalog`. Tests:
`npm test -w @qenbel/engine-catalog` (176 pass on `qenbel_admin_test`), `npm run check -w @qenbel/engine-catalog` clean.
Regression tests are in `packages/engine-catalog/test/channel-gating.test.ts` unless noted.

| ID | Status | What changed |
| --- | --- | --- |
| SEC-006 (High) | Fixed | `searchCustomersForAi` on `web_chat`/`whatsapp`/`voice` is bound to `ctx.subject.customerId`: the query is restricted to that id, all filters must match it, and the only possible result is the subject's own minimal record. No subject, a malformed subject, an archived subject, another tenant's subject or a miss all return the same `{ customers: [] }`; with no subject no SQL runs. The PoC cases (`name: "bh"`, `phone: +919811100001` from WhatsApp) return nothing. Dashboard and `api` keep the tenant-wide minimal lookup (same channel split as engine-bookings/engine-orders). |
| Staff-only gate (part of SEC-006/007/008 decision) | Fixed | Every other function is `staffOp`: FORBIDDEN with `details.reason = "CHANNEL_NOT_ALLOWED"` on customer channels, before validation or SQL (no id probing; existing and unknown ids give identical errors). Channel-callable: `searchCustomersForAi`, `getCatalogueForChannel`, `getBusinessProfileForChannel`, `loadAvailabilityInputs`, `createFollowUp`, `logCommunication`. A test enumerates every export. `createCustomer` is staff-only (its dedupe answer would return another customer's full record). Unknown channel values fail closed. |
| SEC-014 (Medium, engine part) | Partly fixed | `createFollowUp` from a customer channel: subject required, refs must be the subject's (NOT_FOUND otherwise), origin forced to `ai_escalation`, no assignee or due time, and a repeat within 30 minutes returns the open task instead of creating another. Tool-call, token and loop budgets remain for the Stage 4 runtime. |
| SEC-022 (Low) | Fixed | `mapPgError` no longer copies constraint names into `details` (contact unique indexes map to `details.field` only). |
| LIKE escaping | Verified + tests | `likeEscape` + `escape '\'` on every LIKE (customers, catalogue, channel catalogue, resources); tests for `%`, `_`, `\`, `%%`, mixed patterns on staff and channel searches. |
| Caps | Verified + tests | List `limit` 1-100 (channel catalogue 1-50, AI search 1-5), cursors <= 512 chars and validated, search terms bounded (120 customers, 100 catalogue/resources, AI name 2-120). |
| Archived records | Verified + tests | AI search never returns archived customers (including an archived subject); channel catalogue hides archived items, inactive categories and inactive variants. |
| AI-safe catalogue | Verified + tests | `getCatalogueForChannel` output keys are an explicit whitelist (item and variant); SKU, tax, buffer, resource type, attributes, sort order and timestamps never appear on any customer channel; other tenants' items never appear. Business profile for channels returns its whitelisted keys only. |
| Prototype pollution | Verified + tests | Attribute keys must match `^[A-Za-z][A-Za-z0-9_]{0,39}$` with scalar values; an own `__proto__` key from `JSON.parse` is dropped by zod and never stored; `Object.prototype` stays clean. No deep merge in the package. |
| Review note: interim `attributes.timeOff/serviceIds` | Fixed (Stage 2.6) | The engine reads and writes `resource_time_off`, `resource_breaks`, `resource_services` only. |

Not engine-catalog: SEC-001/002/003/010/011/012/013 (db, api-core), SEC-004/005/008/009/020 (engine-bookings, engine-orders),
SEC-007 (engine-orders).

## Open questions

1. `api` is trusted (dashboard-equivalent) by the shared channel split, so an API-key caller gets the tenant-wide minimal
   AI search and staff functions. The API must give voice platforms and other end-customer integrations the `voice` (or
   another customer) channel, never `api`, and limit `api` credentials by permission and tool scope.
2. The tool output of `search_customer` still includes `customerId` (the subject's own on customer channels). The review
   suggests keeping ids server-side; that is a tool-registry schema change.
3. `docs/security/poc/engine-abuse.test.ts` SEC-006 should now pass (its contexts carry no subject); its `todo` marker can
   be removed when the PoCs are re-run on the scratch database (not run here; the scratch database is not touched by
   this package's tests).
4. The escalation dedupe window uses the database clock (the clock that stamps `created_at`), not `ctx.now()`.
