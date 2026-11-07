import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { withTenant, type PoolClient } from "../src/index.ts";
import { at, attempt, baseFixture, connectTestDb, createTenant, insertRow, type TestDb } from "./helpers.ts";

// Migration 013: resource_time_off, resource_breaks, resource_services, and the move of the interim
// resources.attributes.{timeOff,breaks,serviceIds} values into them.

let db: TestDb;
let A: string;
let B: string;
let fa: Awaited<ReturnType<typeof baseFixture>>;
let fb: Awaited<ReturnType<typeof baseFixture>>;
let itemA: string;
let itemB: string;

before(async () => {
  db = await connectTestDb();
  A = await createTenant(db, "avail-a");
  B = await createTenant(db, "avail-b");
  fa = await baseFixture(db, A, { resources: 2 });
  fb = await baseFixture(db, B, { resources: 1 });
  itemA = await withTenant(db.app, A, (c) => insertRow(c, "catalogue_items", { tenant_id: A, kind: "service", name: "Cut", base_price_paise: 100, duration_minutes: 30 }));
  itemB = await withTenant(db.app, B, (c) => insertRow(c, "catalogue_items", { tenant_id: B, kind: "service", name: "Cut", base_price_paise: 100, duration_minutes: 30 }));
});
after(async () => {
  await db.close();
});

const r0 = () => fa.resources[0] as string;
const r1 = () => fa.resources[1] as string;

describe("resource_time_off", () => {
  it("stores an interval that behaves as a half-open range", async () => {
    const id = await withTenant(db.app, A, (c) => insertRow(c, "resource_time_off", { tenant_id: A, resource_id: r0(), starts_at: at(0), ends_at: at(60), reason: "Leave" }));
    const row = await withTenant(db.app, A, async (c) =>
      (await c.query<{ in_range: boolean; edge: boolean }>(
        "select tstzrange(starts_at, ends_at, '[)') @> $2::timestamptz as in_range, tstzrange(starts_at, ends_at, '[)') @> $3::timestamptz as edge from resource_time_off where id = $1",
        [id, at(30), at(60)])).rows[0]);
    assert.equal(row?.in_range, true);
    assert.equal(row?.edge, false, "ends_at is exclusive");
  });

  it("rejects an empty or reversed interval, a 501-character reason, and an exact duplicate", async () => {
    const base = { tenant_id: A, resource_id: r0() };
    const ins = (v: Record<string, unknown>) =>
      attempt(db.app, A, "insert into resource_time_off (tenant_id, resource_id, starts_at, ends_at, reason) values ($1, $2, $3, $4, $5)",
        [v.tenant_id ?? base.tenant_id, base.resource_id, v.starts_at, v.ends_at, v.reason ?? null]);
    for (const r of [await ins({ starts_at: at(100), ends_at: at(100) }), await ins({ starts_at: at(100), ends_at: at(90) }), await ins({ starts_at: at(100), ends_at: at(110), reason: "x".repeat(501) })]) {
      assert.deepEqual(r.ok ? null : r.code, "23514");
    }
    assert.equal((await ins({ starts_at: at(200), ends_at: at(210) })).ok, true);
    const dup = await ins({ starts_at: at(200), ends_at: at(210) });
    assert.deepEqual(dup.ok ? null : dup.code, "23505");
  });

  it("is tenant-scoped by composite foreign key: A cannot attach time off to B's resource", async () => {
    // the FK check is not filtered by RLS, so the composite (tenant_id, resource_id) is what rejects this
    const r = await attempt(db.app, A, "insert into resource_time_off (tenant_id, resource_id, starts_at, ends_at) values ($1, $2, $3, $4)",
      [A, fb.resources[0], at(0), at(10)]);
    assert.deepEqual(r.ok ? null : r.code, "23503");
  });

  it("created_by_user_id must be a user of the same tenant", async () => {
    const userB = await withTenant(db.app, B, (c) => insertRow(c, "users", { tenant_id: B, auth_provider: "dev", external_subject: `dev|${randomUUID()}`, name: "U", role: "STAFF" }));
    const r = await attempt(db.app, A, "insert into resource_time_off (tenant_id, resource_id, starts_at, ends_at, created_by_user_id) values ($1, $2, $3, $4, $5)",
      [A, r0(), at(300), at(310), userB]);
    assert.deepEqual(r.ok ? null : r.code, "23503");
  });

  it("overlap queries for one resource", async () => {
    const hit = await withTenant(db.app, A, async (c) =>
      (await c.query("select 1 from resource_time_off where resource_id = $1 and tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')", [r0(), at(10), at(20)])).rowCount);
    assert.equal(hit, 1);
    const miss = await withTenant(db.app, A, async (c) =>
      (await c.query("select 1 from resource_time_off where resource_id = $1 and tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')", [r1(), at(10), at(20)])).rowCount);
    assert.equal(miss, 0);
  });

  it("the app role may delete a time-off row (it is an editable list)", async () => {
    const id = await withTenant(db.app, A, (c) => insertRow(c, "resource_time_off", { tenant_id: A, resource_id: r1(), starts_at: at(0), ends_at: at(5) }));
    const r = await attempt(db.app, A, "delete from resource_time_off where id = $1", [id]);
    assert.deepEqual(r.ok ? r.rowCount : null, 1);
  });
});

describe("resource_breaks", () => {
  it("accepts a weekly break and rejects bad weekday, reversed times and duplicates", async () => {
    const ins = (weekday: number, s: string, e: string) =>
      attempt(db.app, A, "insert into resource_breaks (tenant_id, resource_id, weekday, start_time, end_time) values ($1, $2, $3, $4, $5)", [A, r0(), weekday, s, e]);
    assert.equal((await ins(1, "13:00", "14:00")).ok, true);
    for (const r of [await ins(7, "13:00", "14:00"), await ins(-1, "13:00", "14:00"), await ins(2, "14:00", "13:00"), await ins(2, "14:00", "14:00")]) {
      assert.deepEqual(r.ok ? null : r.code, "23514");
    }
    const dup = await ins(1, "13:00", "14:00");
    assert.deepEqual(dup.ok ? null : dup.code, "23505");
    assert.equal((await ins(1, "16:00", "16:15")).ok, true, "several breaks a day are allowed");
  });

  it("cannot point at another tenant's resource", async () => {
    const r = await attempt(db.app, A, "insert into resource_breaks (tenant_id, resource_id, weekday, start_time, end_time) values ($1, $2, 1, '13:00', '14:00')", [A, fb.resources[0]]);
    assert.deepEqual(r.ok ? null : r.code, "23503");
  });
});

describe("resource_services", () => {
  it("links a resource to a service once", async () => {
    const ins = () => attempt(db.app, A, "insert into resource_services (tenant_id, resource_id, catalogue_item_id) values ($1, $2, $3)", [A, r0(), itemA]);
    assert.equal((await ins()).ok, true);
    const dup = await ins();
    assert.deepEqual(dup.ok ? null : dup.code, "23505");
  });

  it("rejects a catalogue item or a resource from another tenant", async () => {
    const wrongItem = await attempt(db.app, A, "insert into resource_services (tenant_id, resource_id, catalogue_item_id) values ($1, $2, $3)", [A, r1(), itemB]);
    assert.deepEqual(wrongItem.ok ? null : wrongItem.code, "23503");
    const wrongResource = await attempt(db.app, A, "insert into resource_services (tenant_id, resource_id, catalogue_item_id) values ($1, $2, $3)", [A, fb.resources[0], itemA]);
    assert.deepEqual(wrongResource.ok ? null : wrongResource.code, "23503");
  });

  it("B cannot see A's links", async () => {
    const n = await withTenant(db.app, B, async (c) => (await c.query("select 1 from resource_services")).rowCount);
    assert.equal(n, 0);
  });
});

// ---- the data move ------------------------------------------------------------------------------------

interface Moved { resources: number; timeOff: number; breakRules: number; serviceLinks: number; skipped: number }

const TABLES = ["resources", "resource_time_off", "resource_breaks", "resource_services", "catalogue_items"];
/** The function forces RLS again on exit; inside the test transaction, open it up again to read the result as owner. */
const unforce = async (c: PoolClient) => { for (const t of TABLES) await c.query(`alter table ${t} no force row level security`); };

/** Owner transaction that is always rolled back: legacy attributes in, app_move_resource_extras(), read back. */
async function inRolledBackOwnerTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.owner.connect();
  try {
    await c.query("begin");
    await unforce(c);
    return await fn(c);
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

describe("app_move_resource_extras(): interim attributes become rows", () => {
  it("moves timeOff, breaks and serviceIds (both engine formats), removes the keys, keeps other attributes", async () => {
    const timeOffId = randomUUID();
    const legacy = {
      colour: "red",
      timeOff: [
        { id: timeOffId, startsAt: "2031-02-01T04:00:00.000Z", endsAt: "2031-02-03T04:00:00.000Z", reason: "Leave" }, // engine-catalog format
        { start: "2031-03-01T00:00:00Z", end: "2031-03-02T00:00:00Z" },                                                // engine-bookings format
      ],
      breaks: [{ start: "13:00", end: "14:00" }],
      serviceIds: [itemA],
    };
    await inRolledBackOwnerTx(async (c) => {
      const res = randomUUID();
      await c.query("insert into resources (id, tenant_id, type, name, attributes) values ($1, $2, 'staff', 'Legacy', $3::jsonb)", [res, A, JSON.stringify(legacy)]);
      const out = (await c.query<{ r: Moved }>("select app_move_resource_extras() as r")).rows[0]?.r as Moved;
      await unforce(c);
      assert.equal(out.timeOff, 2);
      assert.equal(out.breakRules, 1);
      assert.equal(out.serviceLinks, 1);
      assert.equal(out.skipped, 0);

      const attrs = (await c.query<{ attributes: Record<string, unknown> }>("select attributes from resources where id = $1", [res])).rows[0]?.attributes;
      assert.deepEqual(attrs, { colour: "red" });

      const off = (await c.query<{ id: string; reason: string | null; starts_at: Date }>("select id, reason, starts_at from resource_time_off where resource_id = $1 order by starts_at", [res])).rows;
      assert.equal(off.length, 2);
      assert.equal(off[0]?.id, timeOffId, "a uuid id is preserved");
      assert.equal(off[0]?.reason, "Leave");
      assert.equal(off[1]?.reason, null);

      const brk = (await c.query<{ weekday: number }>("select weekday from resource_breaks where resource_id = $1 order by weekday", [res])).rows.map((r) => r.weekday);
      assert.deepEqual(brk, [0, 1, 2, 3, 4, 5, 6], "a daily break becomes one row per weekday");

      const svc = (await c.query<{ catalogue_item_id: string }>("select catalogue_item_id from resource_services where resource_id = $1", [res])).rows;
      assert.deepEqual(svc.map((r) => r.catalogue_item_id), [itemA]);

      // idempotent: a second run finds nothing to do
      const again = (await c.query<{ r: Moved }>("select app_move_resource_extras() as r")).rows[0]?.r as Moved;
      await unforce(c);
      assert.deepEqual(again, { resources: 0, timeOff: 0, breakRules: 0, serviceLinks: 0, skipped: 0 });
      assert.equal((await c.query("select 1 from resource_time_off where resource_id = $1", [res])).rowCount, 2);
    });
  });

  it("keeps entries it cannot convert in attributes.migrationSkipped instead of dropping them", async () => {
    const legacy = {
      timeOff: [{ startsAt: "not a date", endsAt: "2031-01-01T00:00:00Z" }, { startsAt: "2031-01-02T00:00:00Z", endsAt: "2031-01-01T00:00:00Z" }, { startsAt: "2031-04-01T00:00:00Z", endsAt: "2031-04-02T00:00:00Z" }],
      breaks: [{ start: "25:00", end: "26:00" }, { start: "15:00", end: "14:00" }],
      serviceIds: [itemB, "nope", itemA],      // itemB belongs to tenant B
    };
    await inRolledBackOwnerTx(async (c) => {
      const res = randomUUID();
      await c.query("insert into resources (id, tenant_id, type, name, attributes) values ($1, $2, 'staff', 'Messy', $3::jsonb)", [res, A, JSON.stringify(legacy)]);
      const out = (await c.query<{ r: Moved }>("select app_move_resource_extras() as r")).rows[0]?.r as Moved;
      await unforce(c);
      assert.equal(out.timeOff, 1);
      assert.equal(out.breakRules, 0);
      assert.equal(out.serviceLinks, 1);
      assert.equal(out.skipped, 6);
      const attrs = (await c.query<{ attributes: { migrationSkipped: { timeOff: unknown[]; breaks: unknown[]; serviceIds: unknown[] } } & Record<string, unknown> }>(
        "select attributes from resources where id = $1", [res])).rows[0]?.attributes;
      assert.equal(attrs?.timeOff, undefined);
      assert.equal(attrs?.migrationSkipped.timeOff.length, 2);
      assert.equal(attrs?.migrationSkipped.breaks.length, 2);
      assert.deepEqual(attrs?.migrationSkipped.serviceIds, [itemB, "nope"]);
      // never links another tenant's item
      const linked = (await c.query("select 1 from resource_services where resource_id = $1 and catalogue_item_id = $2", [res, itemB])).rowCount;
      assert.equal(linked, 0);
    });
  });

  it("leaves resources without the interim keys untouched", async () => {
    await inRolledBackOwnerTx(async (c) => {
      const res = randomUUID();
      await c.query("insert into resources (id, tenant_id, type, name, attributes) values ($1, $2, 'room', 'Plain', '{\"floor\": 2}'::jsonb)", [res, A]);
      const before = (await c.query<{ updated_at: Date }>("select updated_at from resources where id = $1", [res])).rows[0]?.updated_at;
      await c.query("select app_move_resource_extras()");
      await unforce(c);
      const after = (await c.query<{ updated_at: Date; attributes: unknown }>("select updated_at, attributes from resources where id = $1", [res])).rows[0];
      assert.deepEqual(after?.attributes, { floor: 2 });
      assert.equal(after?.updated_at.getTime(), before?.getTime());
    });
  });

  it("forces row level security again afterwards, and the runtime role cannot call it", async () => {
    await inRolledBackOwnerTx(async (c) => {
      await c.query("select app_move_resource_extras()");
      const forced = (await c.query<{ relname: string; relforcerowsecurity: boolean }>(
        "select relname, relforcerowsecurity from pg_class where relname = any($1)", [["resources", "resource_time_off", "resource_breaks", "resource_services", "catalogue_items"]])).rows;
      assert.equal(forced.length, 5);
      assert.ok(forced.every((r) => r.relforcerowsecurity), "FORCE must be restored");
    });
    const r = await attempt(db.app, A, "select app_move_resource_extras()");
    assert.deepEqual(r.ok ? null : r.code, "42501");
    const stillForced = await db.owner.query("select relname from pg_class where relname in ('resources', 'catalogue_items', 'resource_services') and not relforcerowsecurity");
    assert.equal(stillForced.rowCount, 0);
  });
});
