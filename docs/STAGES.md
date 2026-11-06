# Stages and ownership

Coordinator (main session) owns: root files, `docs/ARCHITECTURE.md`, `docs/BRAND.md`, `docs/STAGES.md`, `packages/shared/src/enums.ts`, git commits across stages, and merging. Agents work in parallel inside their own paths only.

Rules for every agent
- Dependencies are preinstalled at the root (`npm install` was run once). **Do not run `npm install` or edit root `package.json`/lockfile.** If you need another package, append a line to `docs/CONTRACT-REQUESTS.md` and carry on with what you have.
- Relative imports use the `.ts` extension. Tests are `test/**/*.test.ts` run by `node --test` (native type stripping). Typecheck with `npm run check -w <package>`.
- Local Postgres for tests: Docker is available. Use host port **54329** (the QenBel portal uses 5432), container name `qenbel-admin-db`. Never touch other containers.
- No pushing, no remote repos, no deploys, no real email/WhatsApp/calls. Local commits only if asked by the coordinator; otherwise leave changes uncommitted.
- Finish with a short report: what you built, files, tests run (pass/fail), open questions.

## Stage 0 (done, coordinator)
Root workspace, contracts (`docs/ARCHITECTURE.md`), brand (`docs/BRAND.md`), shared enums, dependency install.

## Stage 1: foundations (4 agents in parallel)
| Agent | Owns | Delivers |
| --- | --- | --- |
| db | `packages/db`, `infra/` | Full schema as SQL migrations (platform + tenant tables), RLS policies, roles, booking exclusion constraint, idempotency table, audit log, outbox, seed with two fake tenants, migrate/seed scripts, docker-compose (Postgres 54329, Redis, MinIO), tests for RLS isolation + double booking + hold expiry |
| core | `packages/shared`, `packages/config-packs` | zod schemas, state-machine helper, error codes, money helpers, pack schema + salon/clinic/restaurant packs, pack validation tests |
| brand-ui | `packages/ui`, `apps/web` (shell only) | `theme.css` from QenBel tokens, self-hosted Hanken Grotesk, Logo, base components, web shell (Vite + React + PWA manifest, router, layout, pack-driven nav placeholder, sign-in placeholder), no third-party assets, brand/a11y checks |
| contracts | `docs/` (new files only), `packages/tool-registry` | `docs/MVP-REQUIREMENTS.md`, tool registry with all 13 tools (zod in/out, permission level, idempotency flag, descriptions), JSON Schema + OpenAPI 3.1 generation, tests |

## Stage 2: engines (after Stage 1 merges)
api-core (NestJS app, tenancy interceptor, auth provider interface, permissions, audit, idempotency), crm-catalogue-resources, booking-engine, order-engine. Parallel by module.

## Stage 3: surfaces
Tool gateway + signed webhooks + notifications; web screens (dashboard, calendar, orders board, customers, catalogue, settings, onboarding with pack choice); public API client generation.

## Stage 4: AI channels
Agent runtime (Claude API tool loop, conversations, caps, escalation), website chat widget, WhatsApp Cloud API adapter, voice provider (Sarvam HTTP tool) template and simulator.

## Stage 5: hardening and shells
AI installation wizard, MCP server, security review, tenant-isolation and prompt-injection test pass, Capacitor and Tauri shells, isolated-deploy template.

Between stages the coordinator reviews every agent's output, runs all tests, and fixes integration gaps before launching the next stage.
