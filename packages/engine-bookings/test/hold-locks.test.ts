// Lock order and hold-expiry events: expireHolds, createHold, confirm, cancel and reschedule race on the same
// resource without deadlocking (40P01 would surface as SERVICE_UNAVAILABLE), and every expired hold is announced once.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ErrorCode, type AppError } from "@qenbel/shared";
import { cancelBooking, confirmBooking, createHold, expireHolds, getBooking, rescheduleBooking } from "../src/index.ts";
import { at, book, connect, ctxFor, rowsOf, seedSalon, tx, type Env, type Salon } from "./helpers.ts";

let env: Env;
before(async () => {
  env = await connect({ max: 24 });
});
after(async () => {
  await env.close();
});

// The allocation trigger and the sweeps judge expiry by a clock, so "already expired" holds are made by moving their expiry
// into the past after creation (creating them with an old ctx.now would let each new hold sweep the previous one).
const LONG_AGO = "2020-01-01T00:00:00.000Z";

/** Holds at these offsets whose expiry is long past that nothing has swept (all created first, then aged). */
async function staleHolds(s: Salon, offsets: readonly number[]): Promise<string[]> {
  const ctx = ctxFor(s.tenantId);
  const ids: string[] = [];
  for (const minutes of offsets) {
    const h = await tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(minutes), catalogueItemId: s.serviceId, resourceId: s.resourceIds[0] as string }));
    ids.push(h.booking.id);
  }
  await tx(env, ctx, async (c) => {
    await c.query("update booking_allocations set expires_at = $2 where tenant_id = $1 and booking_id = any($3::uuid[])", [s.tenantId, LONG_AGO, ids]);
    await c.query("update bookings set hold_expires_at = $2 where tenant_id = $1 and id = any($3::uuid[])", [s.tenantId, LONG_AGO, ids]);
  });
  return ids;
}
const staleHold = async (s: Salon, minutes: number): Promise<string> => (await staleHolds(s, [minutes]))[0] as string;

const expiredEvents = (s: Salon) =>
  rowsOf<{ aggregate_id: string }>(env, s.tenantId, "select aggregate_id from outbox_events where type = 'booking.expired' order by aggregate_id");

function noDeadlock(results: PromiseSettledResult<unknown>[]): void {
  for (const r of results) {
    if (r.status === "rejected") {
      const e = r.reason as AppError;
      assert.notEqual(e.code, ErrorCode.SERVICE_UNAVAILABLE, `a retryable database error (deadlock?) surfaced: ${e.message} ${JSON.stringify(e.details)}`);
    }
  }
}

describe("hold expiry events", () => {
  test("expireHolds queues one booking.expired per hold, in the same transaction (rolls back with it)", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ids = await staleHolds(s, [0, 120, 240]);
    const job = ctxFor(s.tenantId, { kind: "system", actorId: "sweeper" });

    await assert.rejects(
      tx(env, job, async (c) => {
        const r = await expireHolds(c, job);
        assert.equal(r.expired, 3);
        throw new Error("caller failed");
      }),
      /caller failed/,
    );
    assert.deepEqual(await expiredEvents(s), [], "rolled back with the transaction");

    const r = await tx(env, job, (c) => expireHolds(c, job));
    assert.deepEqual([...r.bookingIds].sort(), [...ids].sort());
    assert.deepEqual((await expiredEvents(s)).map((e) => e.aggregate_id), [...ids].sort());
    const again = await tx(env, job, (c) => expireHolds(c, job));
    assert.equal(again.expired, 0);
    assert.equal((await expiredEvents(s)).length, 3, "once per booking");
    const [a] = await rowsOf<{ n: string }>(env, s.tenantId, "select count(*) n from booking_allocations where active");
    assert.equal(a?.n, "0", "every slot is free again");
  });

  test("a new hold over an unswept expired hold expires it (audit + one booking.expired) and takes the slot", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const old = await staleHold(s, 0);
    const ctx = ctxFor(s.tenantId);
    const h = await tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(0), catalogueItemId: s.serviceId, resourceId: s.resourceIds[0] as string }));
    assert.equal(h.booking.status, "HOLD");
    assert.equal((await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: old }))).status, "EXPIRED");
    assert.deepEqual((await expiredEvents(s)).map((e) => e.aggregate_id), [old]);
    const [log] = await rowsOf<{ n: string }>(env, s.tenantId, "select count(*) n from audit_log where action = 'booking.expire' and entity_id = $1", [old]);
    assert.equal(log?.n, "1");
    // A later sweep does not announce it again.
    const job = ctxFor(s.tenantId, { kind: "system", now: new Date() });
    await tx(env, job, (c) => expireHolds(c, job));
    assert.equal((await expiredEvents(s)).length, 1);
  });

  test("an unexpired hold on the same resource is left alone", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const live = await book(env, s, { minutes: 0, confirm: false });
    const stale = await staleHold(s, 240);
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(480), catalogueItemId: s.serviceId, resourceId: s.resourceIds[0] as string }));
    assert.equal((await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: live.id }))).status, "HOLD");
    assert.equal((await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: stale }))).status, "EXPIRED");
  });
});

describe("lock order: resources -> bookings -> allocations", () => {
  test("expireHolds racing createHold on the same resource and slot: no deadlock, one winner, each expired hold announced once", async () => {
    for (let round = 0; round < 8; round++) {
      const s = await seedSalon(env, { resources: 1 });
      const stale = await staleHolds(s, [0, 120, 240]);
      const sweeper = ctxFor(s.tenantId, { kind: "system", actorId: "sweeper", now: new Date() });
      const results = await Promise.allSettled([
        ...Array.from({ length: 3 }, () => tx(env, sweeper, (c) => expireHolds(c, sweeper))),
        ...Array.from({ length: 4 }, (_, i) => {
          const ctx = ctxFor(s.tenantId, { actorId: `staff-${i}`, now: new Date() });
          return tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(0), catalogueItemId: s.serviceId, resourceId: s.resourceIds[0] as string }));
        }),
      ]);
      noDeadlock(results);
      const sweeps = results.slice(0, 3);
      assert.ok(sweeps.every((r) => r.status === "fulfilled"), `round ${round}: every sweep succeeded`);
      const holds = results.slice(3);
      const winners = holds.filter((r) => r.status === "fulfilled");
      assert.equal(winners.length, 1, `round ${round}: exactly one createHold wins the slot`);
      for (const l of holds.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
        assert.equal((l.reason as AppError).code, ErrorCode.BOOKING_SLOT_TAKEN);
      }
      const rows = await rowsOf<{ id: string; status: string }>(env, s.tenantId, "select id, status from bookings order by id");
      assert.deepEqual(rows.filter((r) => stale.includes(r.id)).map((r) => r.status), ["EXPIRED", "EXPIRED", "EXPIRED"]);
      assert.equal(rows.filter((r) => r.status === "HOLD").length, 1);
      const [active] = await rowsOf<{ n: string }>(env, s.tenantId, "select count(*) n from booking_allocations where active");
      assert.equal(active?.n, "1");
      const events = (await expiredEvents(s)).map((e) => e.aggregate_id);
      assert.deepEqual(events, [...stale].sort(), `round ${round}: one booking.expired per stale hold, no duplicates, none for the live one`);
    }
  });

  test("expireHolds racing confirmBooking on a hold at its expiry: either order is clean", async () => {
    for (let round = 0; round < 10; round++) {
      const s = await seedSalon(env, { resources: 1 });
      const h = await book(env, s, { confirm: false });
      const expiry = Date.parse(h.holdExpiresAt as string);
      const early = ctxFor(s.tenantId, { now: new Date(expiry - 60_000) });
      const late = ctxFor(s.tenantId, { kind: "system", now: new Date(expiry + 1_000) });
      const [c, e] = await Promise.allSettled([
        tx(env, early, (cl) => confirmBooking(cl, early, { bookingId: h.id, customerId: s.customerId })),
        tx(env, late, (cl) => expireHolds(cl, late)),
      ]);
      noDeadlock([c, e]);
      assert.equal(e.status, "fulfilled");
      const now = (await tx(env, early, (cl) => getBooking(cl, early, { bookingId: h.id }))).status;
      const events = (await expiredEvents(s)).length;
      if (c.status === "fulfilled") {
        assert.equal(now, "CONFIRMED");
        assert.equal(events, 0, "a confirmed booking is never announced as expired");
      } else {
        assert.equal((c.reason as AppError).code, ErrorCode.HOLD_EXPIRED);
        assert.equal(now, "EXPIRED");
        assert.equal(events, 1);
      }
    }
  });

  test("expireHolds racing cancelBooking on a hold: one wins, no deadlock, no expired event for a cancelled hold", async () => {
    for (let round = 0; round < 8; round++) {
      const s = await seedSalon(env, { resources: 1 });
      const h = await book(env, s, { confirm: false });
      const expiry = Date.parse(h.holdExpiresAt as string);
      const early = ctxFor(s.tenantId, { now: new Date(expiry - 60_000) });
      const late = ctxFor(s.tenantId, { kind: "system", now: new Date(expiry + 1_000) });
      const [c, e] = await Promise.allSettled([
        tx(env, early, (cl) => cancelBooking(cl, early, { bookingId: h.id })),
        tx(env, late, (cl) => expireHolds(cl, late)),
      ]);
      noDeadlock([c, e]);
      assert.equal(e.status, "fulfilled");
      const status = (await tx(env, early, (cl) => getBooking(cl, early, { bookingId: h.id }))).status;
      const events = (await expiredEvents(s)).length;
      if (c.status === "fulfilled") {
        assert.deepEqual([status, events], ["CANCELLED", 0]);
      } else {
        assert.equal((c.reason as AppError).code, ErrorCode.INVALID_TRANSITION);
        assert.deepEqual([status, events], ["EXPIRED", 1]);
      }
    }
  });

  test("rescheduleBooking into a slot held by an unswept expired hold, racing expireHolds and createHold: no deadlock", async () => {
    for (let round = 0; round < 6; round++) {
      const s = await seedSalon(env, { resources: 2 });
      const mine = await book(env, s, { minutes: 0, resourceId: s.resourceIds[0] as string });
      const stale = await staleHold(s, 240);
      const ctx = ctxFor(s.tenantId, { now: new Date() });
      const sweeper = ctxFor(s.tenantId, { kind: "system", now: new Date() });
      const results = await Promise.allSettled([
        tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: mine.id, startsAt: at(240), expectedVersion: mine.version })),
        tx(env, sweeper, (c) => expireHolds(c, sweeper)),
        tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(240), catalogueItemId: s.serviceId, resourceId: s.resourceIds[0] as string })),
        tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(0), catalogueItemId: s.serviceId, resourceId: s.resourceIds[1] as string })),
      ]);
      noDeadlock(results);
      assert.equal(results[1]?.status, "fulfilled");
      assert.equal(results[3]?.status, "fulfilled", "an unrelated resource is never blocked");
      // The reschedule and the createHold race for 14:00 on resource A: exactly one holds it.
      const [taken] = await rowsOf<{ n: string }>(
        env,
        s.tenantId,
        "select count(*) n from booking_allocations where active and resource_id = $1 and period && tstzrange($2::timestamptz, $3::timestamptz)",
        [s.resourceIds[0], at(240), at(300)],
      );
      assert.equal(taken?.n, "1");
      assert.deepEqual((await expiredEvents(s)).map((e) => e.aggregate_id), [stale], "announced once");
    }
  });
});
