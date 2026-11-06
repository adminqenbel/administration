import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { expireBookingHolds, withTenant } from "../src/index.ts";
import { at, attempt, baseFixture, bookSlot, connectTestDb, createTenant, insertRow, period, sleep, type TestDb } from "./helpers.ts";

// (b) double booking, (c) hold expiry, plus the shared-capacity model.

let db: TestDb;

before(async () => {
  db = await connectTestDb({ max: 30 });
});
after(async () => {
  await db.close();
});

const activeAllocations = (tenant: string, resource: string) =>
  withTenant(db.app, tenant, async (c) =>
    Number((await c.query<{ n: string }>("select count(*)::text as n from booking_allocations where resource_id = $1 and active", [resource])).rows[0]?.n));

describe("double booking is impossible (exclusive resources)", () => {
  it("20 concurrent overlapping bookings for one resource: exactly one wins, the rest fail with exclusion_violation", async () => {
    const t = await createTenant(db, "dbl");
    const f = await baseFixture(db, t, { resources: 1 });
    const resource = f.resources[0] as string;
    const N = 20;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        // slightly different ranges that all overlap each other, so this is more than an identical-row race
        bookSlot(db, t, { resourceId: resource, locationId: f.location, customerId: f.customer, from: i % 5, to: 60 + (i % 7) })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(ok.length, 1, `expected exactly one success, got ${ok.length}`);
    assert.equal(failed.length, N - 1);
    for (const r of failed) {
      assert.equal((r.reason as { code?: string }).code, "23P01", `unexpected failure: ${String(r.reason)}`);
      assert.equal((r.reason as { constraint?: string }).constraint, "booking_allocations_no_overlap");
    }
    assert.equal(await activeAllocations(t, resource), 1);
    // the losers' bookings were rolled back with their allocation
    const bookings = await withTenant(db.app, t, async (c) => Number((await c.query("select count(*) as n from bookings")).rows[0]?.n));
    assert.equal(bookings, 1);
  });

  it("repeated rounds of the race never produce two winners", async () => {
    const t = await createTenant(db, "dbl-rounds");
    const f = await baseFixture(db, t, { resources: 1 });
    const resource = f.resources[0] as string;
    for (let round = 0; round < 5; round++) {
      const from = round * 100;
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => bookSlot(db, t, { resourceId: resource, locationId: f.location, customerId: f.customer, from, to: from + 30 })),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `round ${round}`);
    }
    assert.equal(await activeAllocations(t, resource), 5);
  });

  it("adjacent (touching) periods both succeed", async () => {
    const t = await createTenant(db, "adj");
    const f = await baseFixture(db, t, { resources: 1 });
    const resource = f.resources[0] as string;
    const base = { resourceId: resource, locationId: f.location, customerId: f.customer };
    const results = await Promise.allSettled([
      bookSlot(db, t, { ...base, from: 0, to: 60 }),
      bookSlot(db, t, { ...base, from: 60, to: 120 }),
      bookSlot(db, t, { ...base, from: -60, to: 0 }),
    ]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled"]);
    // one minute of overlap is still a conflict
    await assert.rejects(bookSlot(db, t, { ...base, from: 119, to: 180 }), { code: "23P01" });
  });

  it("different resources at the same time both succeed", async () => {
    const t = await createTenant(db, "res");
    const f = await baseFixture(db, t, { resources: 2 });
    const [r1, r2] = f.resources as [string, string];
    const results = await Promise.allSettled([
      bookSlot(db, t, { resourceId: r1, locationId: f.location, customerId: f.customer, from: 0, to: 60 }),
      bookSlot(db, t, { resourceId: r2, locationId: f.location, customerId: f.customer, from: 0, to: 60 }),
    ]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
  });

  it("the same period on the same resource in two different tenants does not conflict", async () => {
    const t1 = await createTenant(db, "ten1");
    const t2 = await createTenant(db, "ten2");
    const f1 = await baseFixture(db, t1, { resources: 1 });
    const f2 = await baseFixture(db, t2, { resources: 1 });
    const results = await Promise.allSettled([
      bookSlot(db, t1, { resourceId: f1.resources[0] as string, locationId: f1.location, customerId: f1.customer, from: 0, to: 60 }),
      bookSlot(db, t2, { resourceId: f2.resources[0] as string, locationId: f2.location, customerId: f2.customer, from: 0, to: 60 }),
    ]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
  });

  it("an inactive allocation does not block, and cancelling a booking releases its slot", async () => {
    const t = await createTenant(db, "cancel");
    const f = await baseFixture(db, t, { resources: 1 });
    const resource = f.resources[0] as string;
    const base = { resourceId: resource, locationId: f.location, customerId: f.customer };
    const booking = await bookSlot(db, t, { ...base, from: 0, to: 60 });
    await assert.rejects(bookSlot(db, t, { ...base, from: 30, to: 90 }), { code: "23P01" });
    const cancel = await attempt(db.app, t, "update bookings set status = 'CANCELLED', cancelled_at = now(), version = version + 1 where id = $1", [booking]);
    assert.ok(cancel.ok && cancel.rowCount === 1);
    assert.equal(await activeAllocations(t, resource), 0);
    await bookSlot(db, t, { ...base, from: 30, to: 90 });
  });

  it("malformed periods are rejected (empty, unbounded, wrong bounds)", async () => {
    const t = await createTenant(db, "badperiod");
    const f = await baseFixture(db, t, { resources: 1 });
    const booking = await bookSlot(db, t, { resourceId: f.resources[0] as string, locationId: f.location, customerId: f.customer, from: 1000, to: 1060 });
    for (const bad of [
      "empty", `[${at(0).toISOString()},)`, `(${at(0).toISOString()},${at(10).toISOString()}]`, `[${at(10).toISOString()},${at(10).toISOString()})`,
    ]) {
      const r = await attempt(db.app, t,
        "insert into booking_allocations (tenant_id, booking_id, resource_id, period) values ($1, $2, $3, $4::tstzrange)",
        [t, booking, f.resources[0], bad]);
      assert.ok(!r.ok && r.code === "23514", `${bad}: ${JSON.stringify(r)}`);
    }
  });

  it("an allocation cannot reference another tenant's resource", async () => {
    const t1 = await createTenant(db, "x1");
    const t2 = await createTenant(db, "x2");
    const f1 = await baseFixture(db, t1, { resources: 1 });
    const f2 = await baseFixture(db, t2, { resources: 1 });
    const booking = await bookSlot(db, t1, { resourceId: f1.resources[0] as string, locationId: f1.location, customerId: f1.customer, from: 0, to: 30 });
    const r = await attempt(db.app, t1,
      "insert into booking_allocations (tenant_id, booking_id, resource_id, period) values ($1, $2, $3, $4::tstzrange)",
      [t1, booking, f2.resources[0], period(200, 230)]);
    assert.ok(!r.ok && r.code === "23503", JSON.stringify(r));
  });
});

describe("hold expiry releases the slot", () => {
  it("a live hold blocks the slot; confirming it keeps the slot and clears the expiry", async () => {
    const t = await createTenant(db, "hold-live");
    const f = await baseFixture(db, t, { resources: 1 });
    const base = { resourceId: f.resources[0] as string, locationId: f.location, customerId: f.customer };
    const hold = await bookSlot(db, t, { ...base, from: 0, to: 60, status: "HOLD", holdExpiresAt: new Date(Date.now() + 10 * 60_000) });
    await assert.rejects(bookSlot(db, t, { ...base, from: 30, to: 90 }), { code: "23P01" });
    await attempt(db.app, t, "update bookings set status = 'CONFIRMED', confirmed_at = now(), hold_expires_at = null, version = version + 1 where id = $1", [hold]);
    const alloc = await withTenant(db.app, t, async (c) => (await c.query<{ expires_at: Date | null; active: boolean }>("select expires_at, active from booking_allocations where booking_id = $1", [hold])).rows[0]);
    assert.equal(alloc?.expires_at, null);
    assert.equal(alloc?.active, true);
    // sweeping must not touch a confirmed booking
    await withTenant(db.app, t, (c) => c.query("select expire_booking_holds_for_current_tenant(now() + interval '1 day')"));
    assert.equal(await activeAllocations(t, f.resources[0] as string), 1);
  });

  it("after the expiry time the sweep marks the booking EXPIRED, frees the allocation, and the slot can be booked", async () => {
    const t = await createTenant(db, "hold-sweep");
    const f = await baseFixture(db, t, { resources: 1 });
    const base = { resourceId: f.resources[0] as string, locationId: f.location, customerId: f.customer };
    const expiresAt = new Date(Date.now() + 1_000);
    const hold = await bookSlot(db, t, { ...base, from: 0, to: 60, status: "HOLD", holdExpiresAt: expiresAt });
    await assert.rejects(bookSlot(db, t, { ...base, from: 0, to: 60 }), { code: "23P01" }, "slot must be held before expiry");
    await sleep(1_300);
    const swept = await withTenant(db.app, t, async (c) => (await c.query<{ n: number }>("select expire_booking_holds_for_current_tenant() as n")).rows[0]?.n);
    assert.equal(swept, 1);
    const state = await withTenant(db.app, t, async (c) => (await c.query<{ status: string; active: boolean; version: number }>(
      "select b.status, a.active, b.version from bookings b join booking_allocations a on a.booking_id = b.id where b.id = $1", [hold])).rows[0]);
    assert.equal(state?.status, "EXPIRED");
    assert.equal(state?.active, false);
    assert.equal(state?.version, 2, "version is bumped by the sweep");
    await bookSlot(db, t, { ...base, from: 0, to: 60 });
    // a second sweep is a no-op
    assert.equal(await withTenant(db.app, t, async (c) => (await c.query<{ n: number }>("select expire_booking_holds_for_current_tenant() as n")).rows[0]?.n), 0);
  });

  it("an expired hold does not block a new booking even if the sweep job has not run (lazy release)", async () => {
    const t = await createTenant(db, "hold-lazy");
    const f = await baseFixture(db, t, { resources: 1 });
    const base = { resourceId: f.resources[0] as string, locationId: f.location, customerId: f.customer };
    const hold = await bookSlot(db, t, { ...base, from: 0, to: 60, status: "HOLD", holdExpiresAt: new Date(Date.now() - 60_000) });
    await bookSlot(db, t, { ...base, from: 30, to: 90 });
    const status = await withTenant(db.app, t, async (c) => (await c.query<{ status: string }>("select status from bookings where id = $1", [hold])).rows[0]?.status);
    assert.equal(status, "EXPIRED");
  });

  it("the cross-tenant sweep expires holds in every tenant and leaves live holds alone", async () => {
    const tA = await createTenant(db, "sweep-a");
    const tB = await createTenant(db, "sweep-b");
    const fA = await baseFixture(db, tA, { resources: 2 });
    const fB = await baseFixture(db, tB, { resources: 1 });
    const past = new Date(Date.now() - 60_000);
    const holdA = await bookSlot(db, tA, { resourceId: fA.resources[0] as string, locationId: fA.location, customerId: fA.customer, from: 0, to: 30, status: "HOLD", holdExpiresAt: past });
    const liveA = await bookSlot(db, tA, { resourceId: fA.resources[1] as string, locationId: fA.location, customerId: fA.customer, from: 0, to: 30, status: "HOLD", holdExpiresAt: new Date(Date.now() + 600_000) });
    const holdB = await bookSlot(db, tB, { resourceId: fB.resources[0] as string, locationId: fB.location, customerId: fB.customer, from: 0, to: 30, status: "HOLD", holdExpiresAt: past });
    const n = await expireBookingHolds(db.app);
    assert.ok(n >= 2, `expected at least 2 expired, got ${n}`);
    const status = (tenant: string, id: string) =>
      withTenant(db.app, tenant, async (c) => (await c.query<{ status: string }>("select status from bookings where id = $1", [id])).rows[0]?.status);
    assert.equal(await status(tA, holdA), "EXPIRED");
    assert.equal(await status(tA, liveA), "HOLD");
    assert.equal(await status(tB, holdB), "EXPIRED");
    // the sweep runs outside any tenant context and leaves none behind
    const leak = await db.app.query("select current_setting('app.tenant_id', true) as t");
    assert.ok(!leak.rows[0]?.t);
  });

  it("a HOLD booking must carry hold_expires_at", async () => {
    const t = await createTenant(db, "hold-check");
    const f = await baseFixture(db, t, { resources: 1 });
    const r = await attempt(db.app, t,
      "insert into bookings (tenant_id, location_id, customer_id, status, source_channel, starts_at, ends_at) values ($1, $2, $3, 'HOLD', 'api', $4, $5)",
      [t, f.location, f.customer, at(0), at(30)]);
    assert.ok(!r.ok && r.code === "23514", JSON.stringify(r));
  });
});

describe("shared-capacity resources (group classes, counter seating)", () => {
  async function sharedResource(t: string, location: string, capacity: number): Promise<string> {
    return withTenant(db.app, t, (c) => insertRow(c, "resources", {
      tenant_id: t, location_id: location, type: "table", name: `Counter ${randomUUID().slice(0, 4)}`, allocation_mode: "shared", capacity_units: capacity,
    }));
  }

  it("20 concurrent 1-unit bookings on a capacity-10 resource: exactly 10 succeed", async () => {
    const t = await createTenant(db, "cap");
    const f = await baseFixture(db, t, { resources: 0 });
    const resource = await sharedResource(t, f.location, 10);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => bookSlot(db, t, { resourceId: resource, locationId: f.location, customerId: f.customer, from: 0, to: 60, units: 1 })),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
    for (const r of results) if (r.status === "rejected") assert.equal((r.reason as { code?: string }).code, "23P01");
  });

  it("capacity is checked at the busiest instant, not by summing every overlap", async () => {
    const t = await createTenant(db, "cap-peak");
    const f = await baseFixture(db, t, { resources: 0 });
    const resource = await sharedResource(t, f.location, 4);
    const base = { resourceId: resource, locationId: f.location, customerId: f.customer };
    await bookSlot(db, t, { ...base, from: 0, to: 120, units: 3 });     // 10:00-12:00 uses 3
    await bookSlot(db, t, { ...base, from: 120, to: 240, units: 3 });   // 12:00-14:00 uses 3
    // 11:00-13:00 overlaps both but never sees more than 3 + 1 at once
    await bookSlot(db, t, { ...base, from: 60, to: 180, units: 1 });
    // 2 units would make 5 > 4 at 11:00 and at 12:00
    await assert.rejects(bookSlot(db, t, { ...base, from: 60, to: 180, units: 1 }), { code: "23P01" });
    await assert.rejects(bookSlot(db, t, { ...base, from: 0, to: 30, units: 2 }), { code: "23P01" });
    // more than the whole capacity can never fit
    await assert.rejects(bookSlot(db, t, { ...base, from: 500, to: 560, units: 5 }), { code: "23P01" });
  });

  it("allocation mode and capacity cannot be changed under active bookings", async () => {
    const t = await createTenant(db, "cap-change");
    const f = await baseFixture(db, t, { resources: 0 });
    const resource = await sharedResource(t, f.location, 4);
    await bookSlot(db, t, { resourceId: resource, locationId: f.location, customerId: f.customer, from: 0, to: 60, units: 2 });
    const mode = await attempt(db.app, t, "update resources set allocation_mode = 'exclusive' where id = $1", [resource]);
    assert.ok(!mode.ok && mode.code === "55000", JSON.stringify(mode));
    const cap = await attempt(db.app, t, "update resources set capacity_units = 1 where id = $1", [resource]);
    assert.ok(!cap.ok && cap.code === "55000", JSON.stringify(cap));
    const grow = await attempt(db.app, t, "update resources set capacity_units = 8 where id = $1", [resource]);
    assert.ok(grow.ok);
  });

  it("clients cannot choose the exclusive flag: it is derived from the resource", async () => {
    const t = await createTenant(db, "cap-flag");
    const f = await baseFixture(db, t, { resources: 1 });
    const resource = f.resources[0] as string;
    const booking = await bookSlot(db, t, { resourceId: resource, locationId: f.location, customerId: f.customer, from: 0, to: 60 });
    const r = await attempt(db.app, t,
      "insert into booking_allocations (tenant_id, booking_id, resource_id, period, exclusive) values ($1, $2, $3, $4::tstzrange, false)",
      [t, booking, resource, period(30, 90)]);
    assert.ok(!r.ok && r.code === "23P01", `a client-supplied exclusive=false must not bypass the constraint: ${JSON.stringify(r)}`);
  });
});
