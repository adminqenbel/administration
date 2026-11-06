# QenBel Administration: connecting channels and agents

How voice platforms, chat platforms, WhatsApp and MCP clients connect to a business on QenBel Administration. For the owner (what to set up) and for the Stage 4 and 5 agents (what to build).

**About third-party platforms.** Provider products change. Anything below about Sarvam, Meta or any other third party is from general knowledge and is marked **to confirm on the provider's docs** where it matters. Our side (the tool gateway, signatures, idempotency) is a contract in `docs/API-CONTRACT.md` and `packages/tool-registry`.

**Secrets.** Never paste a key, token or secret into a chat, an issue, a commit, a screenshot or this repository. The owner creates each secret in the provider's console and places it in QenBel's secrets store or environment under the variable name shown. `.env.example` holds names only. If a step below needs a secret, QenBel's tools ask you to set it yourself and never ask you to send it to us.

## 1. The common path: tool gateway

Every external agent uses the same gateway.

- Endpoint: `POST {base}/v1/tools/{toolName}`. The list a credential may use is `GET {base}/v1/tools`; the OpenAPI 3.1 description is `GET {base}/v1/tools/openapi.json`. A sample is `docs/generated/tools.openapi.json`.
- Auth: `Authorization: Bearer <API key>`. The owner creates one key per integration in Settings, Integrations, API keys. It belongs to one business, carries an allow-list of tools, and is shown once. Revoke it there at any time.
- Never send a business id. The key decides the business. A body with `tenantId`, `role` or any unknown field is refused.
- Write tools need a header `Idempotency-Key`: a value that stays the same when the platform retries the same action and differs for a different action (8 to 128 characters).
- Errors come as `{ "error": { "code", "message", "details" } }`. The `message` is safe to read to a customer.
- Limits: `RateLimit-*` response headers; `429` with `Retry-After`.

What the agent should be told (put this in its prompt):
1. Call `get_business_profile` first and use what it returns for hours, address and policy.
2. Never offer a time without calling `check_availability`. Never say a booking is confirmed until `confirm_booking` returns `CONFIRMED`.
3. If a tool returns an error, use its `message` and, for `BOOKING_SLOT_TAKEN` or `BOOKING_HOLD_EXPIRED`, call `check_availability` again and offer new times.
4. For anything the tools cannot do, call `escalate_to_human` and say the business has been told. Do not promise a reply time.
5. No medical, legal or financial advice. Urgent or medical: `escalate_to_human` with urgency `urgent`.
6. Prices come only from `get_catalogue`.

Which tools each channel gets by default (the owner can narrow this, and widen it only deliberately):

| Tool | Web chat | WhatsApp | Voice | API key |
| --- | :-: | :-: | :-: | :-: |
| `get_business_profile`, `get_catalogue`, `check_availability` | yes | yes | yes | yes |
| `create_booking_hold`, `confirm_booking` | yes | yes | yes | yes |
| `create_order_draft`, `confirm_order` | yes | yes | yes | yes |
| `escalate_to_human` | yes | yes | yes | yes |
| `search_customer`, `reschedule_booking`, `cancel_booking`, `get_order_status`, `cancel_order` | no | yes | no | yes |

Reason: public web chat and phone calls cannot prove who is speaking, so they cannot read or change an existing person's record. On WhatsApp the sender's number is the verified contact, and the server limits calls to records linked to that number.

## 2. Voice with Sarvam (HTTP tools)

Goal: a caller books by phone. The voice platform runs the conversation (speech to text, the language model, text to speech). It reaches QenBel only through HTTPS tool calls.

### Flow

```text
caller speaks  ->  voice agent decides it needs times
  1. POST /v1/tools/get_business_profile        (once, at call start)
  2. POST /v1/tools/check_availability          caller's service and day
        -> agent reads 2 or 3 times back, in local time
  3. caller picks a time
     POST /v1/tools/create_booking_hold         Idempotency-Key required
        -> HOLD with expiresAt
  4. agent asks for name and phone (and any field the profile lists), reads them back
     POST /v1/tools/confirm_booking             Idempotency-Key required
        -> CONFIRMED with reference
  5. agent says the booking is confirmed and reads the reference
```

Error paths the agent must handle:
- `BOOKING_SLOT_TAKEN` at step 3: "That time was just taken." Call `check_availability` again and offer the nearest times.
- `BOOKING_HOLD_EXPIRED` at step 4: start again from step 2.
- `BOOKING_REQUIRED_FIELDS_MISSING` at step 4: `details.missing` names what to ask for.
- `VALIDATION_FAILED`: the agent sent a wrong shape (for example a phone that is not in international format). Fix and retry once.
- Anything else, or two failures in a row: `escalate_to_human`.

### Example calls (placeholders, not real values)

```bash
BASE=https://api.example.com        # your QenBel Administration API address
# KEY is set in your shell or in the voice platform's secret store. Do not paste it anywhere else.

curl -sS -X POST "$BASE/v1/tools/check_availability" \
  -H "Authorization: Bearer $QENBEL_API_KEY" -H "Content-Type: application/json" \
  -d '{"catalogueItemId":"<service id from get_catalogue>","fromDate":"2026-12-01","limit":3}'

curl -sS -X POST "$BASE/v1/tools/create_booking_hold" \
  -H "Authorization: Bearer $QENBEL_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: call-<call id>-hold-1" \
  -d '{"catalogueItemId":"<service id>","startsAt":"2026-12-01T10:30:00+05:30","resourceId":"<resource id from check_availability>"}'

curl -sS -X POST "$BASE/v1/tools/confirm_booking" \
  -H "Authorization: Bearer $QENBEL_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: call-<call id>-confirm-1" \
  -d '{"bookingId":"<booking id from the hold>","customer":{"name":"Asha K","phone":"+919876543210"}}'
```

### The idempotency key on a voice platform

QenBel requires a unique `Idempotency-Key` on write tools. Many voice platforms let an HTTP tool set headers with variables such as a call id or tool-call id (**to confirm on the provider's docs**: which variables Sarvam's HTTP tool supports, and whether a header can be built from them). Use something like `<call id>-<tool name>-<attempt>`.

If the platform cannot set a per-call header, do not use one fixed key: the first booking would then be replayed for every later call. Stage 4 builds a voice adapter route that derives the key from the provider's call id, the tool name and a hash of the body, and calls the same tool code. That is a design decision for Stage 4 and is not available in Stage 1.

### What the owner sets up

1. A Sarvam account and the agent that will answer calls. (**To confirm on the provider's docs**: which Sarvam product handles telephony and HTTP tools, its names and plans.)
2. A telephone number for the agent, from the voice platform or a telephony provider it supports. Number purchase and any Indian telecom or sender registration rules are the owner's to complete with those providers (**to confirm**).
3. In QenBel: Settings, Integrations, API keys, create a key named for this agent, with only the voice tools: `get_business_profile`, `get_catalogue`, `check_availability`, `create_booking_hold`, `confirm_booking`, `escalate_to_human` (add the order tools only if the business takes orders by phone). Copy it once into the voice platform's secret store.
4. In the voice platform: add one HTTP tool per QenBel tool (or import the OpenAPI file if the platform can). Use the tool names and the descriptions from `GET /v1/tools/openapi.json` as they are written for models. Set the `Authorization` header from the secret store.
5. Paste the agent instructions from section 1 into the agent's prompt. Add the business's language and greeting.
6. Test with a call to a number that is not a customer's. QenBel does not place calls in release 1.

QenBel does not need the voice platform's API key and the voice platform does not need anything but the QenBel API key.

## 3. Other voice and chat platforms (generic)

Any platform that can call an HTTPS endpoint with headers and a JSON body works the same way.

Option A, import: give it `GET {base}/v1/tools/openapi.json` (with the bearer key) if it imports OpenAPI 3.x. Check that it keeps the `Idempotency-Key` header on write operations and lets you fill it from a per-call variable.

Option B, function definitions: the registry produces a generic function list (`toProviderFunctionSchemas`): `{ name, description, parameters }` where `parameters` is JSON Schema. Map it to the platform's shape (for Anthropic `input_schema`; for OpenAI-style APIs `parameters` inside a `function` object). Then on a function call, make the HTTPS request above with the function name in the path and the arguments as the body.

Checklist for any platform:
- Set the bearer header from a secret, not a literal in a shared config.
- Do not add `tenantId` or any other field the schema does not list.
- Return our `error.message` to the model as the tool result on failure, so it can use the plain sentence.
- Timeouts: allow at least 10 seconds for a tool call; the gateway answers faster in normal use, but a call can wait on a database lock for a short time.
- Retries: if the platform retries on timeout, it must send the same `Idempotency-Key` again.
- Keep tool results short. The registry already returns only what the model needs.

## 4. WhatsApp Cloud API

Release 1 connects one WhatsApp Business number per business through Meta's WhatsApp Cloud API. QenBel's agent runtime (Stage 4) reads inbound messages from our webhook and replies through the Cloud API.

### What the owner sets up (to confirm on Meta's current docs)

1. A Meta (Facebook) Business account for the business, and business verification if Meta asks for it before the number can message at volume.
2. A Meta developer app with the WhatsApp product added, and a WhatsApp Business account with a phone number registered to the Cloud API. A number already used in the regular WhatsApp app or WhatsApp Business app usually has to be migrated or replaced; check Meta's rules before moving a number in use.
3. A long-lived access token. Meta documents creating one through a system user in Business settings (**to confirm**). Create it in Meta's console and place it in QenBel's secret store as `WHATSAPP_ACCESS_TOKEN`.
4. The app secret from the app settings, placed as `WHATSAPP_APP_SECRET`. It is used to check the signature on every inbound request.
5. A verify token: a random string the owner makes up, placed as `WHATSAPP_VERIFY_TOKEN`. Meta sends it back during webhook setup so that we know the request is the owner's.
6. The phone number id and WhatsApp business account id, entered in Settings, Integrations, WhatsApp. They are identifiers, not secrets. QenBel maps incoming messages to the business by the phone number id.
7. Webhook setup in Meta's console: callback URL `{base}/v1/channels/whatsapp/webhook`, the verify token from step 5, and a subscription to message events for the number.
8. Message templates, submitted in Meta's template manager for approval. The pack lists the templates QenBel sends (booking confirmation, reminder, cancellation) with suggested wording in the plain-voice style; the owner submits them under their own business name. Approval times and category rules are Meta's (**to confirm**).

### How it behaves (our side)

- Verification handshake: Meta calls `GET /v1/channels/whatsapp/webhook` with a mode, a verify token and a challenge. QenBel returns the challenge only if the token matches.
- Signature: each `POST` carries a signature header computed with the app secret over the raw body (Meta documents it as `X-Hub-Signature-256: sha256=<hex>`; **to confirm**). QenBel verifies it with a constant-time compare before parsing. A bad signature gets `401`.
- Tenant: found from the phone number id registered by the owner, never from the message text.
- De-duplication: by the message id in the payload. A message delivered twice is answered once.
- Window: free-form replies are allowed while the customer messaged recently (Meta's customer-service window, 24 hours at the time of writing, **to confirm**). After that only approved templates are sent.
- Identity: the sender's number is the verified contact. Tools that read or change an existing record only act on records linked to that number.
- Opt-out: a customer who writes STOP (or the words the owner configures) stops receiving messages.
- Costs and limits (conversation pricing, messaging tiers, quality rating) are Meta's and change; the owner reviews them in Meta's console (**to confirm**).
- Development and tests never send. A WhatsApp simulator replaces the provider. QenBel sends real WhatsApp messages only after the owner approves it.

## 5. MCP clients

Stage 5 ships an MCP server that exposes the same tools to MCP clients (for example a desktop assistant or an agent framework). The descriptors are generated by `toMcpTools` in the registry: `name`, `title`, `description`, `inputSchema` (JSON Schema, object), `outputSchema`, and `annotations` (read-only, destructive, idempotent hints).

- Auth: the same API key as the gateway, one per client, with its own tool allow-list. The MCP server takes the business from the key. `tenantId` is not in any input schema.
- Writes: the MCP server adds an `Idempotency-Key` for each call itself, derived from the client's request id, so the client and the model never handle it.
- Transport: the server is planned over HTTP (**to confirm** against the MCP specification revision and the clients in use; stdio is an alternative for local use).
- Client configuration varies by client. A typical shape, as an illustration only (**to confirm in the client's docs**):

```json
{
  "mcpServers": {
    "qenbel": {
      "url": "https://api.example.com/mcp",
      "headers": { "Authorization": "Bearer ${QENBEL_API_KEY}" }
    }
  }
}
```

The key stays in the environment of the machine running the client and is not written into the config file.

- Scope advice: give an MCP client the read tools first. Add write tools only for a client you trust, and keep `cancel_booking` and `cancel_order` for clients that talk to the business's own staff.

## 6. Website chat

The widget is one script from QenBel's own origin. The owner adds it to the business's site.

1. In QenBel: Settings, Integrations, Website chat, create a widget key and list the website addresses allowed to use it. The key is public by design: it identifies the business and carries only chat-safe tools. It is not a secret and gives no access to the dashboard API.
2. Add the script tag shown there to the website. It loads nothing from third parties.
3. Check the greeting, the business name and the hours it shows. The assistant tells visitors it is the business's assistant.

## 7. Owner checklist

- [ ] One API key per integration, named for it, with the smallest tool list that works.
- [ ] Keys and tokens kept in each platform's secret store or QenBel's environment, never in chat, email, screenshots or the repository.
- [ ] A test run on each channel with a made-up customer before real customers.
- [ ] Webhook secret set up and checked with the test event (`docs/API-CONTRACT.md`, section 9).
- [ ] Someone watches the dashboard's "needs a person" list during business hours.
- [ ] Revoke any key you no longer use.

## 8. Open questions (for the coordinator)

- Where per-tenant provider secrets are stored in the central cloud (encrypted in the database or a secret manager). Environment variables only work for the isolated deployment.
- Whether Stage 4 builds the voice adapter route that derives the idempotency key (section 2), or relies on providers that can set per-call headers.
- Which exact Sarvam product and HTTP-tool features Stage 4 targets. This needs a read of Sarvam's current documentation and an account to try it.
- Whether the MCP server is a separate process or a route inside the API.
