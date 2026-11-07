// Test helpers: connect to the Docker Postgres test database, create isolated tenants, build contexts.
// The test database is shared with other packages' suites. This package never truncates it: every test file
// makes its own tenants (unique slugs) and only reads and writes inside them.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createPool,
  resolveDatabaseUrls,
  runMigrations,
  TEST_DATABASE,
  withTenant,
  type Pool,
  type PoolClient,
} from "@qenbel/db";
import { AppError, type Channel, type EngineContext, type PrincipalKind } from "@qenbel/shared";

export interface Env {
  /** Runtime role (qenbel_app), subject to RLS. */
  app: Pool;
  /** Owner role, for inspecting rows and for setup that the app role may not do. Also subject to FORCE RLS. */
  owner: Pool;
  close(): Promise<void>;
}

export async function connect(options: { max?: number } = {}): Promise<Env> {
  const urls = resolveDatabaseUrls(TEST_DATABASE);
  const owner = createPool({ connectionString: urls.migrateUrl, max: 3, applicationName: "qenbel-engine-bookings-owner" });
  const app = createPool({ connectionString: urls.appUrl, max: options.max ?? 10, applicationName: "qenbel-engine-bookings" });
  try {
    await owner.query("select 1");
  } catch (err) {
    await Promise.allSettled([owner.end(), app.end()]);
    throw new Error(
      `Test database is not reachable (${(err as Error).message}).\n` +
        "Start it with:  docker compose -f infra/docker-compose.yml up -d   (Postgres on localhost:54329)\n" +
        "or set TEST_DATABASE_URL and TEST_DATABASE_MIGRATE_URL. These tests are never skipped when the database is down.",
    );
  }
  await runMigrations(owner);
  return {
    app,
    owner,
    close: async () => {
      await Promise.allSettled([app.end(), owner.end()]);
    },
  };
}

export const DEFAULT_NOW = new Date("2030-12-20T00:00:00.000Z");

export interface CtxOptions {
  channel?: Channel;
  kind?: PrincipalKind;
  actorId?: string;
  key?: string;
  now?: Date;
}

export function ctxFor(tenantId: string, o: CtxOptions = {}): EngineContext {
  const now = o.now ?? DEFAULT_NOW;
  return {
    tenantId,
    actor: { kind: o.kind ?? "user", id: o.actorId ?? "test-user", channel: o.channel ?? "dashboard" },
    now: () => new Date(now.getTime()),
    newId: () => randomUUID(),
    ...(o.key !== undefined ? { idempotencyKey: o.key } : {}),
  };
}

/** A customer-facing context: an AI or website channel, where lead time, maximum advance and `block` apply. */
export function customerCtx(tenantId: string, o: CtxOptions = {}): EngineContext {
  return ctxFor(tenantId, { channel: "web_chat", kind: "api_credential", actorId: "cred-1", ...o });
}

/** Run an engine call in its own transaction, as the API would. */
export function tx<T>(env: Env, ctx: EngineContext, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(env.app, ctx.tenantId, fn);
}

export async function createTenant(env: Env, o: { pack?: string; timezone?: string; label?: string } = {}): Promise<string> {
  const slug = `${o.label ?? "eb"}-${randomUUID().slice(0, 8)}`;
  const res = await env.app.query<{ id: string }>(
    "select platform_create_tenant($1, $2, 'central', $3, '1.0.0', $4) as id",
    [slug, `Test ${slug}`, o.pack ?? "salon", o.timezone ?? "Asia/Kolkata"],
  );
  return (res.rows[0] as { id: string }).id;
}

export async function insert(c: PoolClient, table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row.id as string | undefined) ?? randomUUID();
  const all = { id, ...row };
  const names = Object.keys(all);
  await c.query(
    `insert into ${table} (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(all),
  );
  return id;
}

export const json = (v: unknown): string => JSON.stringify(v);

export interface Salon {
  tenantId: string;
  locationId: string;
  resourceIds: string[];
  serviceId: string;
  customerId: string;
}

export interface SalonOptions {
  pack?: string;
  timezone?: string;
  resources?: number;
  durationMinutes?: number;
  bufferMinutes?: number;
  /** Weekdays (0 = Sunday) that are open, 10:00 to 20:00. Default Monday to Saturday. */
  openWeekdays?: number[];
  resourceType?: string;
  pricePaise?: number;
}

/** A tenant with one location, opening hours, N staff resources, one 60 minute service and one customer. */
export async function seedSalon(env: Env, o: SalonOptions = {}): Promise<Salon> {
  const timezone = o.timezone ?? "Asia/Kolkata";
  const tenantId = await createTenant(env, { ...(o.pack !== undefined ? { pack: o.pack } : {}), timezone });
  return withTenant(env.app, tenantId, async (c) => {
    const locationId = await insert(c, "locations", { tenant_id: tenantId, name: "Main", timezone, is_default: true });
    for (const weekday of o.openWeekdays ?? [1, 2, 3, 4, 5, 6]) {
      await insert(c, "business_hours", { tenant_id: tenantId, location_id: locationId, weekday, open_time: "10:00", close_time: "20:00" });
    }
    const resourceIds: string[] = [];
    for (let i = 0; i < (o.resources ?? 2); i++) {
      resourceIds.push(
        await insert(c, "resources", {
          tenant_id: tenantId,
          location_id: locationId,
          type: o.resourceType ?? "staff",
          name: `Staff ${String.fromCharCode(65 + i)}`,
        }),
      );
    }
    const serviceId = await insert(c, "catalogue_items", {
      tenant_id: tenantId,
      kind: "service",
      name: "Haircut",
      base_price_paise: o.pricePaise ?? 50_000,
      duration_minutes: o.durationMinutes ?? 60,
      buffer_minutes: o.bufferMinutes ?? 0,
    });
    const customerId = await insert(c, "customers", {
      tenant_id: tenantId,
      name: "Asha Test",
      phone: `+9190000${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`,
    });
    return { tenantId, locationId, resourceIds, serviceId, customerId };
  });
}

/** Monday 2031-01-06 10:00 in Asia/Kolkata (04:30 UTC). `at(60)` is one hour later. */
const BASE_MS = Date.UTC(2031, 0, 6, 4, 30);
export const at = (minutes: number): string => new Date(BASE_MS + minutes * 60_000).toISOString();
export const atDate = (minutes: number): Date => new Date(BASE_MS + minutes * 60_000);
export const MONDAY = "2031-01-06";

export async function expectAppError(
  promise: Promise<unknown>,
  code: string,
  check?: (e: AppError) => void,
): Promise<AppError> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AppError, `expected AppError ${code}, got ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`);
  assert.equal(caught.code, code, `expected ${code}, got ${caught.code} (${caught.message}) ${JSON.stringify(caught.details)}`);
  check?.(caught);
  return caught;
}

export async function outboxTypes(env: Env, tenantId: string): Promise<string[]> {
  const rows = await withTenant(env.app, tenantId, (c) => c.query<{ type: string }>("select type from outbox_events where tenant_id = $1 order by created_at, id", [tenantId]));
  return rows.rows.map((r) => r.type);
}

export async function rowsOf<T extends Record<string, unknown>>(env: Env, tenantId: string, text: string, values: unknown[] = []): Promise<T[]> {
  const res = await withTenant(env.app, tenantId, (c) => c.query<T>(text, values));
  return res.rows;
}

// ---- booking shortcuts -------------------------------------------------------------------------------------------

import { confirmBooking, createHold, type BookingView } from "../src/index.ts";

/** Hold (and optionally confirm) a one hour booking `minutes` after Monday 10:00 IST. */
export async function book(
  env: Env,
  s: { tenantId: string; serviceId: string; customerId: string; resourceIds: string[] },
  o: { minutes?: number; resourceId?: string; resourceIds?: string[]; confirm?: boolean; ctx?: EngineContext; partySize?: number } = {},
): Promise<BookingView> {
  const ctx = o.ctx ?? ctxFor(s.tenantId);
  const held = await tx(env, ctx, (c) =>
    createHold(c, ctx, {
      startsAt: at(o.minutes ?? 0),
      catalogueItemId: s.serviceId,
      ...(o.resourceIds !== undefined ? { resourceIds: o.resourceIds } : { resourceId: o.resourceId ?? s.resourceIds[0] }),
      ...(o.partySize !== undefined ? { partySize: o.partySize } : {}),
    }),
  );
  if (o.confirm === false) return held.booking;
  const done = await tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: held.booking.id, customerId: s.customerId }));
  return done.booking;
}
