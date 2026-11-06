import { randomUUID } from "node:crypto";
import {
  createPool, resolveDatabaseUrls, runMigrations, TEST_DATABASE, withTenant,
  type Pool, type PoolClient,
} from "../src/index.ts";

export interface TestDb {
  /** Runtime role (qenbel_app), subject to RLS. */
  app: Pool;
  /** Owner role (qenbel_migrate). Also subject to FORCE RLS. */
  owner: Pool;
  close(): Promise<void>;
}

/**
 * Connect to the Docker Postgres test database (qenbel_admin_test), migrate it and empty it of tenant data.
 * If the database is unreachable the test run FAILS with instructions. Nothing is skipped silently.
 * Test files run one at a time (--test-concurrency=1), so each file may reset the data.
 */
export async function connectTestDb(options: { max?: number } = {}): Promise<TestDb> {
  const urls = resolveDatabaseUrls(TEST_DATABASE);
  const owner = createPool({ connectionString: urls.migrateUrl, max: 4, applicationName: "qenbel-test-owner" });
  const app = createPool({ connectionString: urls.appUrl, max: options.max ?? 8, applicationName: "qenbel-test-app" });
  try {
    await owner.query("select 1");
  } catch (err) {
    await Promise.allSettled([owner.end(), app.end()]);
    throw new Error(
      `Test database is not reachable (${(err as Error).message}).\n` +
      "Start it with:  docker compose -f infra/docker-compose.yml up -d   (Postgres on localhost:54329)\n" +
      "or set TEST_DATABASE_URL and TEST_DATABASE_MIGRATE_URL. These tests are not skipped when the database is down.",
    );
  }
  await runMigrations(owner);
  await owner.query("truncate table tenants, platform_admins cascade");
  return {
    app,
    owner,
    close: async () => {
      await Promise.allSettled([app.end(), owner.end()]);
    },
  };
}

export async function createTenant(db: TestDb, slugPrefix: string): Promise<string> {
  const slug = `${slugPrefix}-${randomUUID().slice(0, 8)}`;
  const res = await db.app.query<{ id: string }>("select platform_create_tenant($1, $2, 'central', 'salon', '1.0.0') as id", [slug, `Test ${slug}`]);
  return (res.rows[0] as { id: string }).id;
}

export type Row = Record<string, unknown>;

/** Insert a row from an object (identifiers come from test code only). Returns the id. */
export async function insertRow(client: PoolClient, table: string, row: Row): Promise<string> {
  const id = (row.id as string | undefined) ?? randomUUID();
  const all: Row = { id, ...row };
  const names = Object.keys(all);
  await client.query(
    `insert into ${table} (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(all),
  );
  return id;
}

export interface AttemptOk { ok: true; rowCount: number }
export interface AttemptFail { ok: false; code: string; message: string }

/** Run a statement in its own savepoint-free transaction under a tenant context; report row count or error code. */
export async function attempt(pool: Pool, tenantId: string | null, sql: string, params: unknown[] = []): Promise<AttemptOk | AttemptFail> {
  const run = async (c: PoolClient) => c.query(sql, params);
  try {
    if (tenantId === null) {
      const res = await pool.query(sql, params);
      return { ok: true, rowCount: res.rowCount ?? 0 };
    }
    const res = await withTenant(pool, tenantId, run);
    return { ok: true, rowCount: res.rowCount ?? 0 };
  } catch (err) {
    const e = err as { code?: string; message: string };
    return { ok: false, code: e.code ?? "?", message: e.message };
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** UTC instant `minutes` from a fixed base far in the future, so tests never touch "now". */
const BASE = Date.UTC(2031, 0, 6, 4, 30); // Monday 2031-01-06 10:00 IST
export const at = (minutes: number): Date => new Date(BASE + minutes * 60_000);
export const period = (fromMin: number, toMin: number): string => `[${at(fromMin).toISOString()},${at(toMin).toISOString()})`;

/** Minimal location + resources + customer for one tenant, returned as ids. */
export async function baseFixture(db: TestDb, tenantId: string, opts: { resources?: number } = {}) {
  return withTenant(db.app, tenantId, async (c) => {
    const location = await insertRow(c, "locations", { tenant_id: tenantId, name: "Test location" });
    const customer = await insertRow(c, "customers", { tenant_id: tenantId, name: "Test customer", phone: "+919000000999" });
    const resources: string[] = [];
    for (let i = 0; i < (opts.resources ?? 2); i++) {
      resources.push(await insertRow(c, "resources", { tenant_id: tenantId, location_id: location, type: "staff", name: `Resource ${i + 1}` }));
    }
    return { location, customer, resources };
  });
}

/** Insert a booking and its allocation in one transaction (the unit the booking engine will use). */
export async function bookSlot(
  db: TestDb,
  tenantId: string,
  args: {
    resourceId: string; locationId: string; customerId: string; from: number; to: number;
    status?: "HOLD" | "CONFIRMED"; units?: number; holdExpiresAt?: Date;
  },
): Promise<string> {
  return withTenant(db.app, tenantId, async (c) => {
    const status = args.status ?? "CONFIRMED";
    const booking = await insertRow(c, "bookings", {
      tenant_id: tenantId, location_id: args.locationId, customer_id: args.customerId,
      status, source_channel: "api", starts_at: at(args.from), ends_at: at(args.to),
      hold_expires_at: status === "HOLD" ? (args.holdExpiresAt ?? at(0)) : null,
    });
    await c.query(
      `insert into booking_allocations (tenant_id, booking_id, resource_id, period, units, expires_at)
       values ($1, $2, $3, $4::tstzrange, $5, $6)`,
      [tenantId, booking, args.resourceId, period(args.from, args.to), args.units ?? 1, status === "HOLD" ? (args.holdExpiresAt ?? null) : null],
    );
    return booking;
  });
}
