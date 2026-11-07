import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_MIGRATIONS_DIR, withTenant } from "../src/index.ts";
import { attempt, baseFixture, connectTestDb, createTenant, insertRow, type TestDb } from "./helpers.ts";

// Migration 015: orders.discount_*, orders.resource_id, order_items.tax_rate_bps.

let db: TestDb;
let A: string;
let B: string;
let fa: Awaited<ReturnType<typeof baseFixture>>;
let fb: Awaited<ReturnType<typeof baseFixture>>;

before(async () => {
  db = await connectTestDb();
  A = await createTenant(db, "ord-a");
  B = await createTenant(db, "ord-b");
  fa = await baseFixture(db, A, { resources: 1 });
  fb = await baseFixture(db, B, { resources: 1 });
});
after(async () => {
  await db.close();
});

const place = (v: Record<string, unknown>) =>
  attempt(db.app, A, `insert into orders (tenant_id, source_channel, subtotal_paise, discount_paise, total_paise, discount_type, discount_value, discount_reason, discount_cap_override, resource_id)
                       values ($1, 'api', $2, $3, $4, $5, $6, $7, $8, $9)`,
    [A, v.subtotal ?? 1000, v.discount ?? 0, v.total ?? (Number(v.subtotal ?? 1000) - Number(v.discount ?? 0)), v.type ?? null, v.value ?? null, v.reason ?? null, v.override ?? false, v.resource ?? null]);
const code = (r: Awaited<ReturnType<typeof place>>) => (r.ok ? null : r.code);

describe("orders: how the discount was made", () => {
  it("accepts no discount, a fixed amount and a percentage in basis points", async () => {
    assert.equal((await place({})).ok, true);
    assert.equal((await place({ discount: 100, type: "fixed", value: 100, reason: "Regular guest" })).ok, true);
    assert.equal((await place({ discount: 150, type: "percent_bps", value: 1500, reason: "Festival", override: true })).ok, true);
    assert.equal((await place({ discount: 1000, type: "percent_bps", value: 10000 })).ok, true, "100% is the upper bound");
  });

  it("rejects an unknown type, a negative value, a lone type or value, more than 100%, and a long reason", async () => {
    for (const bad of [
      { type: "amount", value: 10 },
      { type: "fixed", value: -1 },
      { type: "fixed" },
      { value: 10 },
      { discount: 1000, type: "percent_bps", value: 10001 },
      { discount: 10, type: "fixed", value: 10, reason: "x".repeat(501) },
    ]) {
      assert.equal(code(await place(bad)), "23514", JSON.stringify(bad));
    }
  });

  it("the money consistency CHECK still applies", async () => {
    assert.equal(code(await place({ subtotal: 1000, discount: 100, total: 1000 })), "23514");
  });

  it("discount_cap_override defaults to false", async () => {
    const id = await withTenant(db.app, A, (c) => insertRow(c, "orders", { tenant_id: A, source_channel: "api" }));
    const row = await withTenant(db.app, A, async (c) => (await c.query<{ discount_cap_override: boolean; discount_type: string | null }>("select discount_cap_override, discount_type from orders where id = $1", [id])).rows[0]);
    assert.equal(row?.discount_cap_override, false);
    assert.equal(row?.discount_type, null);
  });

  it("the discount can be changed and removed again by the runtime role (draft edits)", async () => {
    const id = await withTenant(db.app, A, (c) => insertRow(c, "orders", { tenant_id: A, source_channel: "api", subtotal_paise: 1000, total_paise: 1000 }));
    const set = await attempt(db.app, A, "update orders set discount_type = 'fixed', discount_value = 100, discount_paise = 100, total_paise = 900, discount_reason = 'x' where id = $1", [id]);
    assert.equal(set.ok, true);
    const clear = await attempt(db.app, A, "update orders set discount_type = null, discount_value = null, discount_paise = 0, total_paise = 1000, discount_reason = null where id = $1", [id]);
    assert.equal(clear.ok, true);
  });
});

describe("orders.resource_id (dine-in table)", () => {
  it("accepts a resource of the same tenant", async () => {
    assert.equal((await place({ resource: fa.resources[0] })).ok, true);
  });

  it("rejects another tenant's resource (composite foreign key) and an unknown id", async () => {
    assert.equal(code(await place({ resource: fb.resources[0] })), "23503");
    assert.equal(code(await place({ resource: "00000000-0000-4000-8000-00000000dead" })), "23503");
  });

  it("is nullable, and the runtime role cannot delete a resource that orders point at", async () => {
    assert.equal((await place({})).ok, true);
    const del = await attempt(db.app, A, "delete from resources where id = $1", [fa.resources[0]]);
    assert.equal(del.ok, false, "the runtime role has no DELETE on resources");
  });
});

describe("order_items.tax_rate_bps", () => {
  let order: string;
  before(async () => {
    order = await withTenant(db.app, A, (c) => insertRow(c, "orders", { tenant_id: A, source_channel: "api" }));
  });
  const line = (rate: unknown) =>
    attempt(db.app, A, `insert into order_items (tenant_id, order_id, name, quantity, unit_price_paise, line_total_paise, tax_rate_bps)
                         values ($1, $2, 'Item', 1, 100, 100, $3)`, [A, order, rate]);

  it("defaults to 0 and accepts 0 to 10000", async () => {
    const id = await withTenant(db.app, A, (c) => insertRow(c, "order_items", { tenant_id: A, order_id: order, name: "Plain", quantity: 1, unit_price_paise: 100, line_total_paise: 100 }));
    const row = await withTenant(db.app, A, async (c) => (await c.query<{ tax_rate_bps: number }>("select tax_rate_bps from order_items where id = $1", [id])).rows[0]);
    assert.equal(row?.tax_rate_bps, 0);
    for (const rate of [0, 500, 1800, 10000]) assert.equal((await line(rate)).ok, true);
  });

  it("rejects negative or above 100%", async () => {
    for (const rate of [-1, 10001]) {
      const r = await line(rate);
      assert.equal(r.ok ? null : r.code, "23514");
    }
  });
});

// The backfill statements in 015 run once. Replay them inside a rolled-back transaction against planted legacy data.
describe("migration 015 backfills existing orders", () => {
  it("turns an old discount into a fixed one, lifts the dine-in table out of fulfilments.address, snapshots line tax rates", async () => {
    const sql = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, "015_orders_discount_table.sql"), "utf8");
    const backfill = sql.slice(sql.indexOf("-- An existing discount has no recorded method"));
    assert.ok(backfill.includes("UPDATE orders"), "backfill section found");
    const t = await createTenant(db, "ord-mig");
    const c = await db.owner.connect();
    try {
      await c.query("begin");
      for (const tbl of ["orders", "order_items", "fulfilments", "resources", "catalogue_items"]) await c.query(`alter table ${tbl} no force row level security`);
      const table = await insertRow(c, "resources", { tenant_id: t, type: "table", name: "T1" });
      const otherTenantTable = fb.resources[0] as string;
      const item = await insertRow(c, "catalogue_items", { tenant_id: t, kind: "product", name: "Dosa", base_price_paise: 1000, tax_rate_bps: 500 });
      const discounted = await insertRow(c, "orders", { tenant_id: t, source_channel: "api", subtotal_paise: 1000, discount_paise: 100, total_paise: 900 });
      const dineIn = await insertRow(c, "orders", { tenant_id: t, source_channel: "api" });
      await insertRow(c, "fulfilments", { tenant_id: t, order_id: dineIn, type: "dine_in", address: JSON.stringify({ tableLabel: "T1", resourceId: table }) });
      const foreign = await insertRow(c, "orders", { tenant_id: t, source_channel: "api" });
      await insertRow(c, "fulfilments", { tenant_id: t, order_id: foreign, type: "dine_in", address: JSON.stringify({ resourceId: otherTenantTable }) });
      const junk = await insertRow(c, "orders", { tenant_id: t, source_channel: "api" });
      await insertRow(c, "fulfilments", { tenant_id: t, order_id: junk, type: "dine_in", address: JSON.stringify({ resourceId: "not-a-uuid" }) });
      const li = await insertRow(c, "order_items", { tenant_id: t, order_id: dineIn, catalogue_item_id: item, name: "Dosa", quantity: 1, unit_price_paise: 1000, line_total_paise: 1000 });
      const free = await insertRow(c, "order_items", { tenant_id: t, order_id: dineIn, name: "Custom", quantity: 1, unit_price_paise: 10, line_total_paise: 10 });

      await c.query(backfill);
      for (const tbl of ["orders", "order_items", "fulfilments", "resources", "catalogue_items"]) await c.query(`alter table ${tbl} no force row level security`);

      const o = new Map((await c.query<{ id: string; discount_type: string | null; discount_value: string | null; resource_id: string | null }>(
        "select id, discount_type, discount_value::text, resource_id from orders where tenant_id = $1", [t])).rows.map((r) => [r.id, r]));
      assert.equal(o.get(discounted)?.discount_type, "fixed");
      assert.equal(o.get(discounted)?.discount_value, "100");
      assert.equal(o.get(dineIn)?.discount_type, null);
      assert.equal(o.get(dineIn)?.resource_id, table);
      assert.equal(o.get(foreign)?.resource_id, null, "another tenant's resource is never linked");
      assert.equal(o.get(junk)?.resource_id, null);
      const rates = new Map((await c.query<{ id: string; tax_rate_bps: number }>("select id, tax_rate_bps from order_items where tenant_id = $1", [t])).rows.map((r) => [r.id, r.tax_rate_bps]));
      assert.equal(rates.get(li), 500);
      assert.equal(rates.get(free), 0);
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  });
});
