// Test helpers: connect to the Docker Postgres (fail loudly if unreachable), create tenants and fixtures, build contexts.
// The target database is TEST DB `ORDERS_TEST_DATABASE` (default qenbel_admin_test, the shared one). This package never
// truncates anything: every test file creates fresh tenants with random slugs, so files and packages do not collide.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createPool,
  resolveDatabaseUrls,
  runMigrations,
  withTenant,
  TEST_DATABASE,
  type Pool,
  type PoolClient,
} from "@qenbel/db";
import { AppError, type EngineContext, type Channel } from "@qenbel/shared";

export interface TestDb {
  app: Pool;
  owner: Pool;
  close(): Promise<void>;
}

export async function connect(): Promise<TestDb> {
  const database = process.env.ORDERS_TEST_DATABASE ?? TEST_DATABASE;
  const urls = resolveDatabaseUrls(database);
  const owner = createPool({ connectionString: urls.migrateUrl, max: 3, applicationName: "orders-test-owner" });
  const app = createPool({ connectionString: urls.appUrl, max: 24, applicationName: "orders-test-app", statementTimeoutMs: 20_000 });
  try {
    await owner.query("select 1");
  } catch (err) {
    await Promise.allSettled([owner.end(), app.end()]);
    throw new Error(
      `Test database "${database}" is not reachable (${(err as Error).message}).\n` +
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

export function ctxFor(tenantId: string, overrides: Partial<EngineContext> & { channel?: Channel } = {}): EngineContext {
  const { channel, ...rest } = overrides;
  return {
    tenantId,
    actor: { kind: "user", id: "00000000-0000-0000-0000-0000000000aa", channel: channel ?? "dashboard" },
    now: () => new Date(),
    newId: () => randomUUID(),
    ...rest,
  };
}

export type Client = PoolClient;

/** One engine call in its own tenant transaction, like one API request. */
export function tx<T>(db: TestDb, tenantId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  return withTenant(db.app, tenantId, fn);
}

export async function createTenant(db: TestDb, pack: string | null, prefix = "ord"): Promise<string> {
  const slug = `${prefix}-${randomUUID().slice(0, 8)}`;
  // Since migration 017 the runtime role cannot call platform_create_tenant. The owner role steps into qenbel_platform
  // for this one statement (works with and without 017).
  const client = await db.owner.connect();
  try {
    await client.query("begin");
    await client.query("set local role qenbel_platform");
    const res = await client.query<{ id: string }>("select platform_create_tenant($1, $2, 'central', $3, $4) as id", [
      slug,
      `Test ${slug}`,
      pack,
      pack === null ? null : "1.0.0",
    ]);
    await client.query("commit");
    return (res.rows[0] as { id: string }).id;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function insert(c: Client, table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row.id as string | undefined) ?? randomUUID();
  const all = { id, ...row };
  const names = Object.keys(all);
  await c.query(
    `insert into ${table} (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(all),
  );
  return id;
}

export interface Fixture {
  tenantId: string;
  locationId: string;
  customerId: string;
  /** a second customer in the same tenant */
  otherCustomerId: string;
  tableId: string;
  /** 5% tax, 10000 paise */
  tikka: string;
  /** 18% tax, 4950 paise */
  soda: string;
  /** 0% tax, 100 paise */
  papad: string;
  /** has variants: base 20000, "Half" 12000, "Full" 20000 (id in variants) */
  biryani: string;
  variants: { half: string; full: string };
  /** exists but available = false */
  soldOut: string;
  /** exists but archived */
  archived: string;
}

/** A restaurant tenant with a location, two customers, a table and a small menu. */
export async function restaurantFixture(db: TestDb, pack: string | null = "restaurant"): Promise<Fixture> {
  const tenantId = await createTenant(db, pack);
  return tx(db, tenantId, async (c) => {
    const t = { tenant_id: tenantId };
    const locationId = await insert(c, "locations", { ...t, name: "Main", is_default: true });
    const customerId = await insert(c, "customers", { ...t, name: "Asha Rao", phone: "+919811100001", email: "asha@example.com" });
    const otherCustomerId = await insert(c, "customers", { ...t, name: "Bala Iyer", phone: "+919811100002" });
    const tableId = await insert(c, "resources", { ...t, location_id: locationId, type: "table", name: "Table 6", capacity_units: 4 });
    const item = (name: string, price: number, taxBps: number, extra: Record<string, unknown> = {}) =>
      insert(c, "catalogue_items", { ...t, kind: "product", name, base_price_paise: price, tax_rate_bps: taxBps, ...extra });
    const tikka = await item("Paneer tikka", 10000, 500);
    const soda = await item("Lime soda", 4950, 1800);
    const papad = await item("Papad", 100, 0);
    const biryani = await item("Biryani", 20000, 500);
    const half = await insert(c, "catalogue_variants", { ...t, item_id: biryani, name: "Half", price_paise: 12000 });
    const full = await insert(c, "catalogue_variants", { ...t, item_id: biryani, name: "Full", price_paise: 20000 });
    const soldOut = await item("Special thali", 30000, 500, { available: false });
    const archived = await item("Old dessert", 8000, 500, { archived_at: new Date().toISOString() });
    return { tenantId, locationId, customerId, otherCustomerId, tableId, tikka, soda, papad, biryani, variants: { half, full }, soldOut, archived };
  });
}

/** Run `fn` and assert it rejects with an AppError of `code` (and optionally details.reason). Returns the error. */
export async function rejectsWith(fn: () => Promise<unknown>, code: string, reason?: string): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError ${code}, got ${(err as Error)?.stack ?? String(err)}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message} ${JSON.stringify(err.details)}`);
    if (reason !== undefined) assert.equal(err.details.reason, reason);
    return err;
  }
  assert.fail(`expected AppError ${code}, but the call succeeded`);
}

export async function count(c: Client, sql: string, params: unknown[] = []): Promise<number> {
  const res = await c.query<{ n: string }>(sql, params);
  return Number(res.rows[0]?.n ?? 0);
}
