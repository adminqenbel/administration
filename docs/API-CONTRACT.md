# QenBel Administration: API contract

For the Stage 2 and 3 api agents and for anyone building a client. It extends section 7 and 8 of `docs/ARCHITECTURE.md` and does not replace them. Tool schemas are not repeated here: they live in `packages/tool-registry` and the generated sample is `docs/generated/tools.openapi.json`.

Everything here is a contract for the api agents to build against. Where a value is a proposal the api-core agent may refine (marked **proposed**), it records the change in `docs/CONTRACT-REQUESTS.md`.

## 1. Conventions

- Base path `/v1`. JSON in and out, UTF-8, `Content-Type: application/json`. Field names are `camelCase`.
- Ids are UUIDs. Timestamps are ISO 8601 with an offset (`2026-12-01T10:30:00+05:30`); the server stores UTC. Dates are `YYYY-MM-DD` in the location's local time zone.
- Money is an integer in paise, in fields ending `AmountPaise`, with a `currency` code. Never a decimal.
- Unknown request fields are refused with `VALIDATION_FAILED` (closed objects), so a typo is not silently dropped.
- Request bodies are limited to 256 KB (**proposed**), strings are length-bounded by the schema.
- **The tenant is never sent.** No path, query, body or header carries a tenant id or a role. The server takes the tenant from the signed-in user or the API credential. Sending `tenantId` returns `VALIDATION_FAILED`.
- Every route declares one permission (section 2). A route without one fails a test.

## 2. Authentication and permissions

Principals:

| Principal | How it authenticates | Used for |
| --- | --- | --- |
| `user` | Session verified on the server (the `clerk` provider checks signature, expiry, issuer and authorised party). Browser calls also carry a CSRF token on state-changing requests. | Dashboard API |
| `api_credential` | `Authorization: Bearer <key>`. One tenant, one integration, an allow-list of tools. Keys are random, stored as peppered hashes, shown once. | Tool gateway, outbound integrations |
| `widget_key` | Public key in the request, maps to one tenant, chat-safe tools only. | `/v1/public/chat/*` |
| `provider_signature` | Provider's own signature, verified before parsing. | Inbound channel webhooks |
| `platform_admin` | Platform session. | `/v1/platform/*` |

Route markers: `public` (no principal; listed explicitly and rate limited), `authenticated` (any signed-in user, no tenant needed, for example creating the first tenant), or a permission string `<module>:<action>`.

Role matrix (**proposed**; api-core confirms):

| Permission | OWNER | MANAGER | STAFF |
| --- | :-: | :-: | :-: |
| `dashboard:read`, `bookings:read`, `orders:read`, `customers:read`, `catalogue:read`, `resources:read`, `tasks:read`, `conversations:read`, `business:read` | yes | yes | yes |
| `bookings:write`, `orders:write`, `customers:write`, `tasks:write`, `conversations:write` | yes | yes | yes |
| `catalogue:write`, `resources:write`, `business:write`, `payments:read`, `payments:write`, `audit:read`, `reports:read`, `integrations:read` | yes | yes | no |
| `users:read` | yes | yes | no |
| `users:write`, `integrations:manage`, `business:pack` | yes | no | no |

`PLATFORM_ADMIN` has `platform:admin` only and no tenant data access except through audited support routes.

An API credential's effective permissions are the tool's `requiredPermission` (from the registry) intersected with the credential's tool allow-list. A tool is usable only if the pack allows it, the tenant enabled it and the credential or channel is scoped to it.

## 3. Errors

Every non-2xx response has this shape and nothing else at the top level:

```json
{
  "error": {
    "code": "BOOKING_SLOT_TAKEN",
    "message": "That time is no longer free.",
    "details": {}
  }
}
```

- `code` is stable and machine readable, exported from `@qenbel/shared`. Clients branch on `code`, never on `message`.
- `message` is a plain sentence that is safe to show a customer (see the plain-voice rules in `docs/MVP-REQUIREMENTS.md`). No stack traces, SQL, ids of other tenants or internal names.
- `details` is always an object, empty if there is nothing to add. Validation errors list `{ "issues": [{ "path": "customer.name", "message": "..." }] }`. Missing booking fields list `{ "missing": ["dateOfBirth"] }`.
- An id that exists in another tenant returns `404` with the same body as an id that does not exist.

Status mapping:

| Status | Used for | Example codes |
| --- | --- | --- |
| 400 | Bad input, missing idempotency key | `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REQUIRED` |
| 401 | No or bad credential | `UNAUTHENTICATED` |
| 403 | Not allowed | `FORBIDDEN`, `TOOL_NOT_ALLOWED`, `CONTACT_MISMATCH` |
| 404 | Not found, or not yours | `BOOKING_NOT_FOUND`, `ORDER_NOT_FOUND`, `TOOL_NOT_FOUND` |
| 409 | State or timing conflict | `BOOKING_SLOT_TAKEN`, `BOOKING_HOLD_EXPIRED`, `BOOKING_VERSION_CONFLICT`, `ORDER_INVALID_STATE`, `IDEMPOTENCY_KEY_IN_USE` |
| 422 | Valid shape, business rule says no | `BOOKING_REQUIRED_FIELDS_MISSING`, `BOOKING_OUTSIDE_HOURS`, `ORDER_ITEM_UNAVAILABLE`, `IDEMPOTENCY_KEY_REUSED` |
| 429 | Rate limited | `RATE_LIMITED` |
| 500 | Our fault | `INTERNAL_ERROR` |

The tool-level codes and their default messages are in `packages/tool-registry/src/errors.ts` (`TOOL_ERROR_CATALOGUE`) until `@qenbel/shared` publishes the platform list; the shared list must include every tool code.

## 4. Pagination

List endpoints take `?limit=&cursor=` and return:

```json
{ "data": [ ... ], "page": { "nextCursor": "opaque-string-or-null", "hasMore": true } }
```

- `limit` defaults to 25, maximum 100. Above the maximum is `VALIDATION_FAILED`.
- `cursor` is opaque and tied to the same filters and sort. Do not parse it. A cursor from another tenant or another query is refused with `VALIDATION_FAILED`.
- Order is stable: a documented sort per endpoint with `id` as the tie-breaker, so paging never skips or repeats rows while data changes.
- Filters are plain query parameters (`status=CONFIRMED&from=2026-12-01&to=2026-12-07`). There is no free-form query language.

## 5. Idempotency

- Header `Idempotency-Key: <8 to 128 characters of A-Z a-z 0-9 _ . : ->`.
- Required on every tool write call (`create_booking_hold`, `confirm_booking`, `reschedule_booking`, `cancel_booking`, `create_order_draft`, `confirm_order`, `cancel_order`, `escalate_to_human`) and on dashboard `POST` routes that create bookings, orders or payments. Missing: `400 IDEMPOTENCY_KEY_REQUIRED`.
- Stored per `(tenant_id, key, route)` with a hash of the request body and the stored response, for 24 hours.
- Same key, same body: the stored status and body are returned with `Idempotent-Replayed: true`, and nothing new is created. This includes stored error responses for 4xx business errors, but not 5xx.
- Same key, different body: `422 IDEMPOTENCY_KEY_REUSED`.
- Same key while the first call is still running: `409 IDEMPOTENCY_KEY_IN_USE`. The client waits and retries.
- Make the key from something that is the same on a retry of one intended action and different for another: for an AI runtime, the conversation id plus the model's tool-call id. A random key made fresh on every retry defeats the purpose.
- The key is never part of a tool's input schema, and the model never chooses it.

## 6. Rate limits

- Limits apply per API credential, per signed-in user and per tenant, and per client address on `public` routes. The numbers are configuration, not contract.
- Every response from a limited route carries: `RateLimit-Limit` (requests allowed in the window), `RateLimit-Remaining`, `RateLimit-Reset` (seconds until the window resets).
- A refused call returns `429` with `RATE_LIMITED` and `Retry-After: <seconds>`. Clients wait at least that long and add jitter.

## 7. Versioning

- The path carries the major version: `/v1`. Within a version, only additive changes: new endpoints, new optional request fields, new response fields, new enum values for response fields. Clients must ignore response fields they do not know.
- A breaking change (removing or renaming a field, tightening validation, changing meaning) needs `/v2`, run side by side with `/v1` for a stated period.
- Webhook payloads carry `apiVersion` (`"v1"`) and follow the same rule.
- The OpenAPI 3.1 document is generated from the zod schemas and is the machine-readable truth. The sample for the tool gateway is `docs/generated/tools.openapi.json`.

## 8. Optimistic concurrency

Bookings and orders carry `version` (integer, starts at 1, rises on every change). A change request carries the `version` it last saw in the body (`version`; tools use `expectedVersion`). A stale value returns `409 BOOKING_VERSION_CONFLICT` or `ORDER_VERSION_CONFLICT` and changes nothing.

## 9. Webhooks (outbound)

### Envelope

```json
{
  "eventId": "evt_01JEXAMPLE",
  "type": "booking.confirmed",
  "apiVersion": "v1",
  "createdAt": "2026-12-01T10:30:02+05:30",
  "data": { "bookingId": "b00c1d2e-3f40-4a51-8b62-73849a5b6c7d", "status": "CONFIRMED", "startsAt": "2026-12-01T15:00:00+05:30" }
}
```

`data` holds the resource as the dashboard API would return it, with personal fields limited to what the endpoint's owner chose to receive (**proposed**: names and masked contacts by default). The event types are in `WebhookEvent` in `@qenbel/shared`: `booking.created`, `booking.confirmed`, `booking.rescheduled`, `booking.cancelled`, `booking.no_show`, `booking.completed`, `order.created`, `order.accepted`, `order.fulfilled`, `order.cancelled`, `customer.created`, `payment.completed`.

Delivery is at least once. Receivers must treat `eventId` as the de-duplication key. Order across events is not guaranteed; use `createdAt` and the resource `version`.

### Headers

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `QenBel-Webhooks/1` |
| `QenBel-Event-Id` | same as `eventId` |
| `QenBel-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` |

### Signing

The signed string is the timestamp, a dot, and the raw request body exactly as sent: `"<t>." + rawBody`. The key is the endpoint's signing secret, shown once when the endpoint is created or the secret rotated. `v1` is the lowercase hex of `HMAC-SHA256(secret, signedString)`. During a rotation the header may carry two `v1=` values; accept if either matches.

Receivers must: read the raw body before any JSON parsing, reject timestamps more than 5 minutes from now, compare with a constant-time function, and de-duplicate on `eventId`.

### Worked example (Node, no dependencies)

```js
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

const SECRET = process.env.QENBEL_WEBHOOK_SECRET; // set by you, never committed
const TOLERANCE_SECONDS = 300;
const seen = new Set(); // use a database or cache with expiry in real code

export function verifyQenBelSignature({ rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const entries = String(header ?? "").split(",").map((p) => {
    const i = p.indexOf("=");
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  });
  const t = Number(entries.find(([k]) => k === "t")?.[1]);
  const candidates = entries.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isInteger(t) || candidates.length === 0) return false;
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return candidates.some((hex) => {
    const given = Buffer.from(hex, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      if (!verifyQenBelSignature({ rawBody, header: req.headers["qenbel-signature"], secret: SECRET })) {
        res.writeHead(401).end();
        return;
      }
      const event = JSON.parse(rawBody);
      if (!seen.has(event.eventId)) {
        seen.add(event.eventId);
        // handle event.type here, quickly; do slow work after responding
      }
      res.writeHead(200).end(); // any 2xx within 10 seconds counts as delivered
    });
  })
  .listen(3000);
```

A test vector for the platform's own test: secret `whsec_example_not_a_real_secret`, body `{"eventId":"evt_1","type":"booking.confirmed"}`, timestamp `t`: the header is `t=<t>,v1=HMAC-SHA256-hex(secret, "<t>." + body)`. Changing one byte of the body, or `t` by more than 300 seconds from now, makes verification fail.

### Retry schedule (proposed)

A delivery succeeds on any `2xx` within 10 seconds. Anything else (non-2xx, timeout, connection error, redirect) is a failure.

| Attempt | Wait after previous failure |
| --- | --- |
| 1 | immediately |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 | 6 hours |
| 7 | 24 hours |

After attempt 7 the delivery is marked `failed` and shown on the dashboard with the last status and a redeliver button. Add up to 20% random jitter to each wait. An endpoint that fails 100 deliveries in a row is paused and the owner is told on the dashboard (**proposed**). Each attempt is recorded with time, status code and duration, never the receiver's response body beyond the first 1 KB.

Endpoint rules: HTTPS only, no private, loopback or link-local addresses (checked at save and at send), no redirects followed, at most 20 endpoints per tenant.

### Inbound channel webhooks

Verify the provider's signature on the raw body first. Find the tenant from the provider id that the owner registered (for WhatsApp, the phone number id), never from the payload's text. Answer quickly with `200` and process from a queue. De-duplicate on the provider's message id. See `docs/INTEGRATIONS.md`.

## 10. Endpoint list: dashboard API

Paths are relative to `/v1`. "Perm" is the permission string checked on the server. `Idem` marks routes that need `Idempotency-Key`. Writes also write an audit event. List endpoints use section 4.

### Session and onboarding

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| GET | `/me` | `authenticated` | Signed-in user, tenant (if any), role, permissions. |
| POST | `/onboarding/tenants` | `authenticated` | Body: business name, pack id. Creates the tenant and makes the caller OWNER. Idem. |
| GET | `/packs` | `authenticated` | Packs available to choose. |
| GET | `/packs/{packId}` | `authenticated` | Terminology, defaults, required fields, tool allow-list. |
| GET | `/onboarding/status` | `business:read` | Which setup steps are done. |

### Business configuration

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| GET | `/business` | `business:read` | Profile, pack, defaults. |
| PATCH | `/business` | `business:write` | Name, contact, policies, hold minutes, required customer fields. |
| PUT | `/business/pack` | `business:pack` | Change pack. OWNER only. Warns about config that no longer fits. |
| GET | `/locations` | `business:read` | |
| POST | `/locations` | `business:write` | IANA time zone required. |
| GET | `/locations/{locationId}` | `business:read` | |
| PATCH | `/locations/{locationId}` | `business:write` | |
| POST | `/locations/{locationId}/archive` | `business:write` | |
| GET | `/locations/{locationId}/hours` | `business:read` | Weekly hours and closures. |
| PUT | `/locations/{locationId}/hours` | `business:write` | |
| GET | `/business/tools` | `integrations:read` | Tools allowed by pack, enabled by tenant. |
| PUT | `/business/tools` | `integrations:manage` | Enable or disable within the pack's allow-list. |

### Team

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| GET | `/team/members` | `users:read` | |
| POST | `/team/invitations` | `users:write` | Email and role. |
| PATCH | `/team/members/{memberId}` | `users:write` | Change role. |
| DELETE | `/team/members/{memberId}` | `users:write` | Cannot remove the last OWNER. |

### Customers

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| GET | `/customers` | `customers:read` | `q` (name, phone, email), `tag`, paging. |
| POST | `/customers` | `customers:write` | Returns the existing one on a matching phone (R4.2). |
| GET | `/customers/{customerId}` | `customers:read` | |
| PATCH | `/customers/{customerId}` | `customers:write` | |
| POST | `/customers/{customerId}/archive` | `customers:write` | |
| POST | `/customers/{customerId}/restore` | `customers:write` | |

### Catalogue

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| GET | `/catalogue/items` | `catalogue:read` | `kind`, `category`, `q`, `archived`. |
| POST | `/catalogue/items` | `catalogue:write` | `amountPaise` integer. |
| GET | `/catalogue/items/{itemId}` | `catalogue:read` | |
| PATCH | `/catalogue/items/{itemId}` | `catalogue:write` | |
| POST | `/catalogue/items/{itemId}/archive` | `catalogue:write` | |
| POST | `/catalogue/items/{itemId}/restore` | `catalogue:write` | |
| GET | `/catalogue/categories` | `catalogue:read` | |
| POST | `/catalogue/categories` | `catalogue:write` | |
| PATCH | `/catalogue/categories/{categoryId}` | `catalogue:write` | |
| DELETE | `/catalogue/categories/{categoryId}` | `catalogue:write` | Only if empty. |

### Resources and schedules

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| GET | `/resources` | `resources:read` | `type`, `locationId`, `archived`. |
| POST | `/resources` | `resources:write` | Type must be allowed by the pack. |
| GET | `/resources/{resourceId}` | `resources:read` | |
| PATCH | `/resources/{resourceId}` | `resources:write` | |
| POST | `/resources/{resourceId}/archive` | `resources:write` | Refused with future bookings. |
| GET | `/resources/{resourceId}/schedule` | `resources:read` | Weekly working hours. |
| PUT | `/resources/{resourceId}/schedule` | `resources:write` | |
| GET | `/resources/{resourceId}/time-off` | `resources:read` | |
| POST | `/resources/{resourceId}/time-off` | `resources:write` | Refused over booked times (R6.5). |
| DELETE | `/resources/{resourceId}/time-off/{timeOffId}` | `resources:write` | |
| PUT | `/resources/{resourceId}/services` | `resources:write` | Which catalogue items this resource can serve. |

### Bookings

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| GET | `/availability` | `bookings:read` | Same engine as `check_availability`. |
| GET | `/bookings` | `bookings:read` | `status`, `from`, `to`, `resourceId`, `customerId`, `channel`. |
| POST | `/bookings/holds` | `bookings:write` | Idem. Creates `HOLD`. |
| POST | `/bookings` | `bookings:write` | Idem. Staff shortcut: hold and confirm in one step. |
| GET | `/bookings/{bookingId}` | `bookings:read` | |
| GET | `/bookings/{bookingId}/events` | `bookings:read` | Timeline from the audit log. |
| POST | `/bookings/{bookingId}/confirm` | `bookings:write` | Idem. `HOLD` to `CONFIRMED`. |
| POST | `/bookings/{bookingId}/reschedule` | `bookings:write` | Idem. Body carries `version`. |
| POST | `/bookings/{bookingId}/cancel` | `bookings:write` | Idem. Returns the policy applied. |
| POST | `/bookings/{bookingId}/transition` | `bookings:write` | `to` is `CHECKED_IN`, `COMPLETED` or `NO_SHOW`; body carries `version`. |

### Orders and payment ledger

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| GET | `/orders` | `orders:read` | `status`, `from`, `to`, `customerId`, `channel`. |
| POST | `/orders` | `orders:write` | Idem. Creates `DRAFT`. Prices come from the catalogue. |
| GET | `/orders/{orderId}` | `orders:read` | |
| PATCH | `/orders/{orderId}` | `orders:write` | Lines and notes, only while `DRAFT`. Body carries `version`. |
| POST | `/orders/{orderId}/place` | `orders:write` | Idem. `DRAFT` to `PLACED`. |
| POST | `/orders/{orderId}/transition` | `orders:write` | `to` is a pack-allowed next status; body carries `version`. |
| POST | `/orders/{orderId}/cancel` | `orders:write` | Idem. |
| GET | `/orders/{orderId}/payments` | `payments:read` | Ledger entries. |
| POST | `/orders/{orderId}/payments` | `payments:write` | Idem. Records a payment made outside QenBel (amount in paise, method, note). Writes `payment.completed`. |

### Tasks and conversations

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| GET | `/tasks` | `tasks:read` | `status`, `assignee`, `urgency`. |
| POST | `/tasks` | `tasks:write` | |
| PATCH | `/tasks/{taskId}` | `tasks:write` | Status, assignee, note. |
| GET | `/conversations` | `conversations:read` | `channel`, `needsHuman`. |
| GET | `/conversations/{conversationId}` | `conversations:read` | Includes messages and tool calls (personal details masked for STAFF below MANAGER, **proposed**). |
| POST | `/conversations/{conversationId}/takeover` | `conversations:write` | Assistant stops replying. |
| POST | `/conversations/{conversationId}/messages` | `conversations:write` | Staff reply on the original channel. |
| POST | `/conversations/{conversationId}/release` | `conversations:write` | Hand back to the assistant. |

### Dashboard

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| GET | `/dashboard/today` | `dashboard:read` | Today's bookings, orders by status, open tasks, conversations needing a person. Widgets follow the pack. |
| GET | `/dashboard/summary` | `dashboard:read` | Simple counts for a date range. No analytics in release 1. |

### Integrations, credentials, webhooks, audit

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| GET | `/integrations/channels` | `integrations:read` | Status of website chat, WhatsApp, voice. No secrets returned. |
| PUT | `/integrations/channels/{channel}` | `integrations:manage` | Non-secret settings and the name of the secret to read from the environment or secret store. |
| POST | `/integrations/channels/{channel}/test` | `integrations:manage` | Runs against the simulator unless the owner has approved live sending. |
| GET | `/integrations/widget-keys` | `integrations:read` | |
| POST | `/integrations/widget-keys` | `integrations:manage` | Allowed origins list. |
| POST | `/integrations/widget-keys/{keyId}/revoke` | `integrations:manage` | |
| GET | `/integrations/api-credentials` | `integrations:read` | Names, prefixes, tool allow-lists, last used. Never the key. |
| POST | `/integrations/api-credentials` | `integrations:manage` | Returns the key once. Idem. |
| POST | `/integrations/api-credentials/{credentialId}/revoke` | `integrations:manage` | |
| PUT | `/integrations/api-credentials/{credentialId}/tools` | `integrations:manage` | Allow-list within what the pack and tenant allow. |
| GET | `/webhooks/endpoints` | `integrations:read` | |
| POST | `/webhooks/endpoints` | `integrations:manage` | URL, events. Returns the signing secret once. |
| PATCH | `/webhooks/endpoints/{endpointId}` | `integrations:manage` | |
| DELETE | `/webhooks/endpoints/{endpointId}` | `integrations:manage` | |
| POST | `/webhooks/endpoints/{endpointId}/rotate-secret` | `integrations:manage` | Old and new both valid for 24 hours. |
| POST | `/webhooks/endpoints/{endpointId}/test` | `integrations:manage` | Sends a signed test event. |
| GET | `/webhooks/deliveries` | `integrations:read` | `endpointId`, `status`, `eventType`. |
| POST | `/webhooks/deliveries/{deliveryId}/redeliver` | `integrations:manage` | |
| GET | `/audit-events` | `audit:read` | `actor`, `action`, `from`, `to`. Read only. |

### Wizard (Stage 5)

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| POST | `/wizard/sessions` | `business:write` | |
| POST | `/wizard/sessions/{sessionId}/messages` | `business:write` | Returns reply and a proposal list. Nothing is saved. |
| POST | `/wizard/sessions/{sessionId}/apply` | `business:write` | Applies the proposals the owner confirmed, through the same services and audit as settings. |

## 11. Endpoint list: gateway, public and platform

| Method | Path | Principal and perm | Notes |
| --- | --- | --- | --- |
| GET | `/tools` | `api_credential` | Tools this credential may call now (pack, tenant, credential). |
| GET | `/tools/openapi.json` | `api_credential` | OpenAPI 3.1 for those tools, from the registry. |
| POST | `/tools/{toolName}` | `api_credential`, tool's `requiredPermission` | Body is the tool input. Idem on write tools. Returns the tool output or an error. |
| POST | `/public/chat/sessions` | `widget_key` | Starts a conversation. Returns a session token scoped to it. |
| POST | `/public/chat/sessions/{sessionId}/messages` | `widget_key` + session token | Plain-text message in; assistant reply out. |
| GET | `/public/chat/sessions/{sessionId}/messages` | `widget_key` + session token | Poll messages after a cursor. A streaming variant is decided in Stage 4. |
| GET | `/channels/whatsapp/webhook` | `provider_signature` (verification handshake) | Answers the provider's setup challenge. |
| POST | `/channels/whatsapp/webhook` | `provider_signature` | Inbound WhatsApp events. |
| POST | `/channels/voice/{provider}/webhook` | `provider_signature` | Inbound voice-provider events, if the provider sends them. |
| GET | `/platform/tenants` | `platform:admin` | |
| POST | `/platform/tenants/{tenantId}/suspend` | `platform:admin` | Platform routes are the only place a tenant id is in a path, and only for platform admins. |
| POST | `/platform/tenants/{tenantId}/resume` | `platform:admin` | |
| GET | `/health` | `public` | Liveness only; no version, no tenant data. |

## 12. Open items for api-core

- Final permission strings for `dashboard`, `payments`, `tasks`, `conversations`, `users`, `business:pack`, `integrations:read` (new beyond the examples in `ARCHITECTURE.md` section 4).
- Shared error code list to include every code in `TOOL_ERROR_CATALOGUE`.
- How per-tenant channel secrets are stored in the central cloud (environment only works for isolated mode).
- Whether `POST /bookings` (staff hold-and-confirm in one step) is needed or the dashboard calls the two routes in sequence.
