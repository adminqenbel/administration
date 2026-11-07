import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { withTenant, type PoolClient } from "../src/index.ts";
import { at, baseFixture, connectTestDb, createTenant, insertRow, period, sleep, type TestDb } from "./helpers.ts";

// Lock ordering between the hold-expiry sweeps and the allocation insert trigger.
//
// Before migration 016 the sweep updated `bookings` first and then (through bookings_sync_allocations) the
// allocations, while the insert trigger released expired overlapping holds allocation-first and then updated
// their bookings. Opposite orders on the same rows: a sweep racing a new hold on a slot still occupied by
// expired, unswept holds could be aborted with SQLSTATE 40P01. The canonical order is now
// resource -> booking (ascending id) -> allocation, in the trigger and in both sweeps.

let db: TestDb;

before(async () => {
  db = await connectTestDb({ max: 24 });
});
after(async () => {
  await db.close();
});

const PAST = () => new Date(Date.now() - 60_000);

/** Insert `n` expired, unswept holds on separate consecutive slots of one resource. Returns booking ids. */
async function seedExpiredHolds(tenantId: string, f: { location: string; customer: string }, resource: string, n: number, slotMin: number): Promise<string[]> {
  return withTenant(db.app, tenantId, async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const from = i * slotMin;
      const to = from + slotMin;
      const booking = await insertRow(c, "bookings", {
        tenant_id: tenantId, location_id: f.location, customer_id: f.customer, status: "HOLD", source_channel: "api",
        starts_at: at(from), ends_at: at(to), hold_expires_at: PAST(),
      });
      await c.query(
        `insert into booking_allocations (tenant_id, booking_id, resource_id, period, expires_at)
         values ($1, $2, $3, $4::tstzrange, $5)`,
        [tenantId, booking, resource, period(from, to), PAST()],
      );
      ids.push(booking);
    }
    return ids;
  });
}

/** A new hold over [0, totalMin): overlaps every expired hold seeded above, so the trigger must release them all. */
async function createWideHold(tenantId: string, f: { location: string; customer: string }, resource: string, totalMin: number): Promise<string> {
  return withTenant(db.app, tenantId, async (c: PoolClient) => {
    const booking = await insertRow(c, "bookings", {
      tenant_id: tenantId, location_id: f.location, customer_id: f.customer, status: "HOLD", source_channel: "api",
      starts_at: at(0), ends_at: at(totalMin), hold_expires_at: new Date(Date.now() + 600_000),
    });
    await c.query(
      `insert into booking_allocations (tenant_id, booking_id, resource_id, period, expires_at)
       values ($1, $2, $3, $4::tstzrange, $5)`,
      [tenantId, booking, resource, period(0, totalMin), new Date(Date.now() + 600_000)],
    );
    return booking;
  });
}

const code = (r: PromiseSettledResult<unknown>): string | null =>
  r.status === "fulfilled" ? null : ((r.reason as { code?: string }).code ?? "?");

describe("hold sweep vs allocation insert: no lock-order deadlock", () => {
  // Deterministic interleaving. A third session pins the last booking of the batch, so the sweep is stuck
  // part-way through its booking locks while the insert trigger takes the allocation locks. Releasing the pin
  // lets both continue. With opposite lock orders (before migration 016) one of them is aborted with 40P01.
  for (const [label, sweep] of [
    ["cross-tenant sweep", (t: string) => { void t; return db.app.query("select expire_booking_holds()"); }],
    ["tenant sweep", (t: string) => withTenant(db.app, t, (c) => c.query("select expire_booking_holds_for_current_tenant()"))],
  ] as const) {
    it(`forced interleaving: ${label} vs new hold over the same expired holds`, async () => {
      const t = await createTenant(db, "sweep-forced");
      const f = await baseFixture(db, t, { resources: 1 });
      const resource = f.resources[0] as string;
      const bookings = await seedExpiredHolds(t, f, resource, 6, 10);
      const pin = await db.app.connect();
      try {
        await pin.query("begin");
        await pin.query("select set_config('app.tenant_id', $1, true)", [t]);
        await pin.query("select id from bookings where id = $1 for update", [bookings[bookings.length - 1]]);
        const sweeping = sweep(t).then(() => null, (e: unknown) => e);
        await sleep(300);
        const inserting = createWideHold(t, f, resource, 60).then(() => null, (e: unknown) => e);
        await sleep(500);
        await pin.query("commit");
        const [sweepErr, insertErr] = await Promise.all([sweeping, inserting]);
        assert.equal((sweepErr as { code?: string } | null)?.code ?? null, null, `sweep failed: ${String(sweepErr)}`);
        assert.equal((insertErr as { code?: string } | null)?.code ?? null, null, `insert failed: ${String(insertErr)}`);
      } finally {
        await pin.query("rollback").catch(() => undefined);
        pin.release();
      }
      const states = await withTenant(db.app, t, async (c) =>
        (await c.query<{ status: string; n: number }>("select status, count(*)::int as n from bookings group by status order by status")).rows);
      assert.deepEqual(states, [{ status: "EXPIRED", n: 6 }, { status: "HOLD", n: 1 }]);
    });
  }

  it("cross-tenant sweep, tenant sweep and a new hold racing over the same expired holds never deadlock", async () => {
    const t = await createTenant(db, "sweep-race");
    const f = await baseFixture(db, t, { resources: 1 });
    const resource = f.resources[0] as string;
    const ROUNDS = 40;
    const HOLDS = 12;
    const SLOT = 10;
    const failures: string[] = [];
    let created = 0;

    for (let round = 0; round < ROUNDS; round++) {
      await seedExpiredHolds(t, f, resource, HOLDS, SLOT);
      const results = await Promise.allSettled([
        createWideHold(t, f, resource, HOLDS * SLOT),
        db.app.query("select expire_booking_holds()"),
        withTenant(db.app, t, (c) => c.query("select expire_booking_holds_for_current_tenant()")),
        db.app.query("select expire_booking_holds()"),
      ]);
      if (results[0]?.status === "fulfilled") created++;
      for (const [i, r] of results.entries()) {
        const c = code(r);
        // the only acceptable failure for the new hold is a lost race for the slot (23P01); never a deadlock
        if (c !== null && !(i === 0 && c === "23P01")) failures.push(`round ${round} op ${i}: ${c}`);
      }
      // clean slate for the next round: free whatever the round left active
      await withTenant(db.app, t, async (c) => {
        await c.query("update bookings set status = 'CANCELLED', cancelled_at = now() where status in ('HOLD', 'CONFIRMED')");
      });
    }
    assert.deepEqual(failures, [], `unexpected errors:\n${failures.join("\n")}`);
    assert.ok(created > 0, "the new hold should win at least once (expired holds never block it)");
  });

  it("two overlapping multi-resource inserts and a sweep never deadlock", async () => {
    const t = await createTenant(db, "sweep-multi");
    const f = await baseFixture(db, t, { resources: 2 });
    const [r1, r2] = f.resources as [string, string];
    const [a, b] = [r1, r2].sort() as [string, string];
    const failures: string[] = [];

    for (let round = 0; round < 25; round++) {
      // expired holds on both resources
      await seedExpiredHolds(t, f, a, 6, 10);
      await seedExpiredHolds(t, f, b, 6, 10);
      const twoResourceHold = () =>
        withTenant(db.app, t, async (c) => {
          const booking = await insertRow(c, "bookings", {
            tenant_id: t, location_id: f.location, customer_id: f.customer, status: "HOLD", source_channel: "api",
            starts_at: at(0), ends_at: at(60), hold_expires_at: new Date(Date.now() + 600_000),
          });
          for (const r of [a, b]) {           // ascending resource_id, as the contract requires
            await c.query(
              `insert into booking_allocations (tenant_id, booking_id, resource_id, period, expires_at)
               values ($1, $2, $3, $4::tstzrange, $5)`,
              [t, booking, r, period(0, 60), new Date(Date.now() + 600_000)],
            );
          }
        });
      const results = await Promise.allSettled([
        twoResourceHold(), twoResourceHold(), db.app.query("select expire_booking_holds()"),
        withTenant(db.app, t, (c) => c.query("select expire_booking_holds_for_current_tenant()")),
      ]);
      for (const [i, r] of results.entries()) {
        const c = code(r);
        if (c !== null && !(i < 2 && c === "23P01")) failures.push(`round ${round} op ${i}: ${c}`);
      }
      await withTenant(db.app, t, (c) => c.query("update bookings set status = 'CANCELLED', cancelled_at = now() where status in ('HOLD', 'CONFIRMED')"));
    }
    assert.deepEqual(failures, [], `unexpected errors:\n${failures.join("\n")}`);
  });

  it("sweeps still expire exactly the due holds, free their allocations and leave live holds alone", async () => {
    const t = await createTenant(db, "sweep-effect");
    const f = await baseFixture(db, t, { resources: 1 });
    const resource = f.resources[0] as string;
    const expired = await seedExpiredHolds(t, f, resource, 3, 10);
    const live = await withTenant(db.app, t, async (c) => {
      const booking = await insertRow(c, "bookings", {
        tenant_id: t, location_id: f.location, customer_id: f.customer, status: "HOLD", source_channel: "api",
        starts_at: at(500), ends_at: at(530), hold_expires_at: new Date(Date.now() + 600_000),
      });
      await c.query(
        `insert into booking_allocations (tenant_id, booking_id, resource_id, period, expires_at) values ($1, $2, $3, $4::tstzrange, $5)`,
        [t, booking, resource, period(500, 530), new Date(Date.now() + 600_000)],
      );
      return booking;
    });
    const swept = await withTenant(db.app, t, async (c) => (await c.query<{ n: number }>("select expire_booking_holds_for_current_tenant() as n")).rows[0]?.n);
    assert.equal(swept, 3);
    const rows = await withTenant(db.app, t, async (c) =>
      (await c.query<{ id: string; status: string; version: number; active: boolean }>(
        `select b.id, b.status, b.version, a.active from bookings b join booking_allocations a on a.booking_id = b.id`)).rows);
    for (const id of expired) {
      const row = rows.find((r) => r.id === id);
      assert.equal(row?.status, "EXPIRED");
      assert.equal(row?.version, 2);
      assert.equal(row?.active, false);
    }
    const liveRow = rows.find((r) => r.id === live);
    assert.equal(liveRow?.status, "HOLD");
    assert.equal(liveRow?.active, true);
    // cross-tenant sweep is a no-op now for this tenant
    await db.app.query("select expire_booking_holds()");
    const again = await withTenant(db.app, t, async (c) => (await c.query<{ n: number }>("select count(*)::int as n from bookings where status = 'EXPIRED'")).rows[0]?.n);
    assert.equal(again, 3);
  });
});
