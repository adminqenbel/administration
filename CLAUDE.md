# QenBel Administration: rules for Claude Code

Product name: **QenBel Administration**. Brand is always written **QenBel**. Read `docs/ARCHITECTURE.md` (contracts), `docs/BRAND.md`, then `docs/STAGES.md` (who owns what). The approved plan is `C:\Users\hemap\.claude\plans\bright-coalescing-frog.md`.

Reference only, never edit: `D:\Qenbel` (static site, brand tokens), `D:\qenbel-portal` (client portal, security conventions).

## Always

- Security before features. Authorisation is checked on the server, on every route, deny by default. A route with no declared permission is a bug and a test fails on it.
- Never accept `tenant_id`, `org_id` or a role from the browser or from an AI agent. Tenant comes from the authenticated principal or the tenant-scoped API credential only.
- Every tenant table has `tenant_id` and Postgres Row-Level Security. The app connects as a role that is subject to RLS (never the owner, never BYPASSRLS).
- Parameterised SQL only. User content is plain text, escaped on output. CSRF protection on browser state-changing requests.
- Money is integer paise (`amount_paise`, bigint), never floats. Timestamps are `timestamptz`, UTC.
- No secrets in the repository, logs or browser. Names only in `.env.example`. If a secret is needed, ask the owner to set it in the environment.
- No third-party scripts, fonts or trackers in the product UI. Fonts are served from our own origin. Strict CSP.
- No generic tools (`execute_sql`, `update_any_record`). Every AI tool is narrow, validated, permissioned, audited and idempotent on writes.
- AI never owns business state. It calls tools; the booking and order engines validate and commit.
- Bookings and orders are separate modules and separate records.
- UI text is plain and short, in the style of qenbel.site. No hype. No promises, guarantees, prices or delivery dates in product copy.
- Tests: plain `node --test` (Node 22.18+ runs `.ts` by native type stripping: no enums, namespaces or parameter properties in packages meant to be tested this way; use `as const` objects and union types). Write tenant-isolation, route-permission and double-booking tests before polishing screens.
- Ask the owner before: creating or changing a remote repository, pushing, deploying, creating cloud resources, sending real email or WhatsApp or placing calls, storing anything real. Local work and local commits are fine.

## Working in parallel

Each agent owns one directory set listed in `docs/STAGES.md` and edits only inside it. Cross-cutting needs go in `docs/CONTRACT-REQUESTS.md` (append a dated line); the coordinator resolves them. Do not edit `docs/ARCHITECTURE.md` without the coordinator.

## Commit style

Small commits, only inside your owned paths. End each commit message with the attribution line the harness gives you.

## Before saying "done"

Run the tests and checks of your package and report any that fail, were skipped, or could not be run.
