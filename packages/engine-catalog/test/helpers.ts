import { randomUUID } from "node:crypto";
import {
  createPool, resolveDatabaseUrls, runMigrations, TEST_DATABASE, withTenant,
  type Pool, type PoolClient,
} from "@qenbel/db";
import { Channel, PrincipalKind, type EngineContext } from "@qenbel/shared";

/** Fixed "now" far from any real data: 2031-01-01 00:00 UTC. Bookings in tests are built around 2031-01-06 (Monday). */
export const NOW = new Date("2031-01-01T00:00:00.000Z");

export interface TestDb {
  /** Runtime role (qenbel_app), subject to RLS. */
  app: Pool;
  /** Owner role, used only to create the schema and to clean up the tenants a test created. */
  owner: Pool;
  createTenant(prefix: string): Promise<string>;
  /** Delete the tenants this test created (best effort) and close the pools. */
  close(): Promise<void>;
}

/**
 * Connect to the Docker Postgres test database. If it is unreachable the run FAILS with instructions; nothing is skipped.
 * Unlike the db package's own tests this does NOT truncate: other packages' tests may be running against the same
 * database at the same time. Every test uses fresh tenants (random slug) and removes them in `close()`.
 */
export async function connectTestDb(): Promise<TestDb> {
  const urls = resolveDatabaseUrls(TEST_DATABASE);
  const owner = createPool({ connectionString: urls.migrateUrl, max: 2, applicationName: "engine-catalog-test-owner" });
  const app = createPool({ connectionString: urls.appUrl, max: 6, applicationName: "engine-catalog-test-app" });
  try {
    await owner.query("select 1");
  } catch (err) {
    await Promise.allSettled([owner.end(), app.end()]);
    throw new Error(
      `Test database is not reachable (${(err as Error).message}).\n` +
        "Start it with:  docker compose -f infra/docker-compose.yml up -d   (Postgres on localhost:54329)\n" +
        "These tests are not skipped when the database is down.",
    );
  }
  await runMigrations(owner);
  const tenants: string[] = [];
  return {
    app,
    owner,
    async createTenant(prefix) {
      const slug = `${prefix}-${randomUUID().slice(0, 8)}`.toLowerCase();
      const res = await app.query<{ id: string }>("select platform_create_tenant($1, $2, 'central', 'salon', '1.0.0') as id", [slug, `Test ${slug}`]);
      const id = (res.rows[0] as { id: string }).id;
      tenants.push(id);
      return id;
    },
    async close() {
      for (const id of tenants) {
        try {
          await removeTenant(owner, id);
        } catch (err) {
          process.stderr.write(`[engine-catalog test] could not remove tenant ${id}: ${(err as Error).message}\n`);
        }
      }
      await Promise.allSettled([app.end(), owner.end()]);
    },
  };
}

// Children first. audit_log is append-only and never written by this package.
const CLEANUP_ORDER = [
  "payments", "fulfilments", "order_items", "orders", "follow_up_tasks", "communications", "notifications", "booking_allocations",
  "bookings", "conversation_messages", "conversations", "customer_notes", "customer_tags", "customers", "resource_schedules",
  "resources", "holidays", "business_hours", "catalogue_variants", "catalogue_items", "catalogue_categories", "outbox_events",
  "user_locations", "users", "locations",
];

async function removeTenant(owner: Pool, tenantId: string): Promise<void> {
  await withTenant(owner, tenantId, async (c) => {
    for (const table of CLEANUP_ORDER) await c.query(`delete from ${table} where tenant_id = $1`, [tenantId]);
    await c.query("delete from tenants where id = $1", [tenantId]);
  });
}

export interface CtxOptions {
  kind?: PrincipalKind;
  channel?: Channel;
  actorId?: string;
  now?: Date;
}

export function makeCtx(tenantId: string, options: CtxOptions = {}): EngineContext {
  return {
    tenantId,
    actor: { kind: options.kind ?? PrincipalKind.SYSTEM, id: options.actorId ?? "test", channel: options.channel ?? Channel.DASHBOARD },
    now: () => options.now ?? NOW,
    newId: () => randomUUID(),
  };
}

/** Run `fn` in one tenant transaction (what the API does per request). */
export function tx<T>(db: TestDb, tenantId: string, fn: (sql: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(db.app, tenantId, fn);
}

/** Run one engine call in its own tenant transaction. */
export function call<I, R>(db: TestDb, ctx: EngineContext, fn: (sql: PoolClient, ctx: EngineContext, input: I) => Promise<R>, input: I): Promise<R> {
  return withTenant(db.app, ctx.tenantId, (c) => fn(c, ctx, input));
}

/** Expect the promise to reject with an AppError of this code. */
export async function rejectsWith(promise: Promise<unknown>, code: string): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; message?: string; details?: Record<string, unknown> };
    if (e.code !== code) throw new Error(`expected ${code} but got ${String(e.code)}: ${e.message}`);
    return { code: e.code, message: e.message ?? "", details: e.details ?? {} };
  }
  throw new Error(`expected rejection with ${code} but it resolved`);
}

// ---- raw fixtures (rows other engines own) ---------------------------------------------------------

/** 2031-01-06 is a Monday. `minutes` after 00:00 UTC on that date. */
const BASE = Date.UTC(2031, 0, 6, 0, 0);
export const at = (minutes: number): Date => new Date(BASE + minutes * 60_000);
export const period = (from: Date, to: Date): string => `[${from.toISOString()},${to.toISOString()})`;

export async function insertBooking(
  c: PoolClient,
  tenantId: string,
  args: {
    locationId?: string | null; customerId?: string | null; itemId?: string | null; resourceId?: string; from: Date; to: Date;
    status?: string; units?: number; holdExpiresAt?: Date; depositPaise?: number;
  },
): Promise<string> {
  const status = args.status ?? "CONFIRMED";
  const hold = status === "HOLD" ? (args.holdExpiresAt ?? new Date(NOW.getTime() + 3600_000)) : null;
  const res = await c.query<{ id: string }>(
    `insert into bookings (tenant_id, location_id, customer_id, catalogue_item_id, status, source_channel, starts_at, ends_at, hold_expires_at, deposit_paise)
     values ($1, $2, $3, $4, $5, 'api', $6, $7, $8, $9) returning id`,
    [tenantId, args.locationId ?? null, args.customerId ?? null, args.itemId ?? null, status, args.from, args.to, hold, args.depositPaise ?? 0],
  );
  const id = (res.rows[0] as { id: string }).id;
  if (args.resourceId) {
    await c.query(
      `insert into booking_allocations (tenant_id, booking_id, resource_id, period, units, expires_at) values ($1, $2, $3, $4::tstzrange, $5, $6)`,
      [tenantId, id, args.resourceId, period(args.from, args.to), args.units ?? 1, hold],
    );
  }
  return id;
}

export async function insertOrder(
  c: PoolClient, tenantId: string, args: { customerId: string; totalPaise: number; status?: string; createdAt?: Date },
): Promise<string> {
  const res = await c.query<{ id: string }>(
    `insert into orders (tenant_id, customer_id, status, source_channel, subtotal_paise, tax_paise, discount_paise, total_paise, created_at)
     values ($1, $2, $3, 'api', $4, 0, 0, $4, coalesce($5, now())) returning id`,
    [tenantId, args.customerId, args.status ?? "PLACED", args.totalPaise, args.createdAt ?? null],
  );
  return (res.rows[0] as { id: string }).id;
}

export async function insertPayment(
  c: PoolClient,
  tenantId: string,
  args: { orderId?: string; bookingId?: string; customerId?: string; kind?: string; amountPaise: number; status?: string },
): Promise<void> {
  await c.query(
    `insert into payments (tenant_id, order_id, booking_id, customer_id, kind, method, status, amount_paise)
     values ($1, $2, $3, $4, $5, 'cash', $6, $7)`,
    [tenantId, args.orderId ?? null, args.bookingId ?? null, args.customerId ?? null, args.kind ?? "payment", args.status ?? "completed", args.amountPaise],
  );
}
