// createHold: double-booking prevention through the engine, idempotency, expiry, capacity, hours rules.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AppError, ErrorCode } from "@qenbel/shared";
import { checkAvailability, confirmBooking, createHold, expireHolds, getBooking } from "../src/index.ts";
import {
  at,
  atDate,
  connect,
  ctxFor,
  customerCtx,
  expectAppError,
  insert,
  outboxTypes,
  rowsOf,
  seedSalon,
  tx,
  type Env,
} from "./helpers.ts";

let env: Env;
before(async () => {
  env = await connect({ max: 24 });
});
after(async () => {
  await env.close();
});

const hold = (s: { tenantId: string; serviceId: string }, extra: Record<string, unknown> = {}) => ({
  startsAt: at(0),
  catalogueItemId: s.serviceId,
  ...extra,
});

describe("double booking through the engine", () => {
  test("20 parallel holds on the same slot: exactly one succeeds, the rest get BOOKING_SLOT_TAKEN", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const attempts = Array.from({ length: 20 }, (_, i) => {
      const ctx = ctxFor(s.tenantId, { actorId: `staff-${i}` });
      return tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: s.resourceIds[0] })));
    });
    const settled = await Promise.allSettled(attempts);
    const winners = settled.filter((r) => r.status === "fulfilled");
    const losers = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(winners.length, 1, `winners: ${winners.length}`);
    for (const l of losers) {
      assert.ok(l.reason instanceof AppError, String(l.reason));
      assert.equal((l.reason as AppError).code, ErrorCode.BOOKING_SLOT_TAKEN);
    }
    const [counts] = await rowsOf<{ b: string; a: string }>(
      env,
      s.tenantId,
      `select (select count(*) from bookings) as b, (select count(*) from booking_allocations where active) as a`,
    );
    assert.deepEqual([counts?.b, counts?.a], ["1", "1"]);
    assert.equal((await outboxTypes(env, s.tenantId)).length, 1, "only the winner wrote an event");
  });

  test("20 parallel holds with no resource named: one per resource (2), the rest are refused", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => {
        const ctx = ctxFor(s.tenantId);
        return tx(env, ctx, (c) => createHold(c, ctx, hold(s)));
      }),
    );
    const ok = settled.filter((r) => r.status === "fulfilled");
    assert.equal(ok.length, 2);
    const resources = new Set(ok.map((r) => (r as PromiseFulfilledResult<{ booking: { resourceId: string } }>).value.booking.resourceId));
    assert.equal(resources.size, 2);
    for (const r of settled) {
      if (r.status === "rejected") assert.equal((r.reason as AppError).code, ErrorCode.BOOKING_SLOT_TAKEN);
    }
  });

  test("touching slots both succeed", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const r = s.resourceIds[0] as string;
    const ctx = ctxFor(s.tenantId);
    const a = await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r, startsAt: at(0) })));
    const b = await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r, startsAt: at(60) })));
    assert.equal(a.booking.endsAt, b.booking.startsAt);
    assert.notEqual(a.booking.id, b.booking.id);
  });

  test("a service with a cleanup buffer blocks the next slot until the buffer is over", async () => {
    const s = await seedSalon(env, { resources: 1, bufferMinutes: 15 });
    const r = s.resourceIds[0] as string;
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r, startsAt: at(0) })));
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r, startsAt: at(60) }))),
      ErrorCode.BOOKING_SLOT_TAKEN,
    );
    await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r, startsAt: at(75) })));
    // And the booking before it: 08:45-09:45 would be fine, but a slot that ends inside the buffer ahead of 10:00 is not.
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r, startsAt: at(-65) }))),
      ErrorCode.BOOKING_SLOT_TAKEN,
    );
  });

  test("the loser leaves nothing behind (no booking row, no allocation, no event)", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const r = s.resourceIds[0] as string;
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r })));
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r }))), ErrorCode.BOOKING_SLOT_TAKEN);
    const [n] = await rowsOf<{ b: string; a: string }>(env, s.tenantId, "select (select count(*) from bookings) b, (select count(*) from booking_allocations) a");
    assert.deepEqual([n?.b, n?.a], ["1", "1"]);
    assert.equal((await outboxTypes(env, s.tenantId)).length, 1);
  });

  test("if the caller swallows the error and commits anyway, the failed attempt still left nothing (savepoint)", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const r = s.resourceIds[0] as string;
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r })));
    await tx(env, ctx, async (c) => {
      await createHold(c, ctx, hold(s, { resourceId: r })).catch(() => undefined);
    });
    const [n] = await rowsOf<{ b: string }>(env, s.tenantId, "select count(*) b from bookings");
    assert.equal(n?.b, "1");
  });
});

describe("multi-resource holds", () => {
  test("opposing resource orders do not deadlock: one winner per round, losers get BOOKING_SLOT_TAKEN", async () => {
    const s = await seedSalon(env, { resources: 3 });
    const [a, b, c3] = s.resourceIds as [string, string, string];
    for (let round = 0; round < 6; round++) {
      const start = at(round * 24 * 60); // Monday to Saturday, 10:00
      const orders = [[a, b], [b, a], [b, c3], [c3, b], [c3, a], [a, c3]];
      const settled = await Promise.allSettled(
        orders.map((resourceIds) => {
          const ctx = ctxFor(s.tenantId);
          return tx(env, ctx, (c) => createHold(c, ctx, { startsAt: start, catalogueItemId: s.serviceId, resourceIds }));
        }),
      );
      const ok = settled.filter((r) => r.status === "fulfilled");
      assert.equal(ok.length, 1, `round ${round}: ${settled.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as AppError).code ?? String(r.reason))).join(",")}`);
      for (const r of settled) {
        if (r.status === "rejected") {
          assert.equal((r.reason as AppError).code, ErrorCode.BOOKING_SLOT_TAKEN, String(r.reason));
        }
      }
    }
  });

  test("a multi-resource booking occupies every resource and frees them together", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    const res = await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceIds: [...s.resourceIds].reverse() })));
    assert.deepEqual(res.booking.resourceIds, [...s.resourceIds].sort());
    const [n] = await rowsOf<{ a: string }>(env, s.tenantId, "select count(*) a from booking_allocations where active");
    assert.equal(n?.a, "2");
    // Either resource alone is now taken at that time.
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: s.resourceIds[1] }))),
      ErrorCode.BOOKING_SLOT_TAKEN,
    );
  });

  test("a multi-resource hold fails as a whole when one resource is busy", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: s.resourceIds[1] })));
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceIds: s.resourceIds }))),
      ErrorCode.BOOKING_SLOT_TAKEN,
    );
    const [n] = await rowsOf<{ b: string }>(env, s.tenantId, "select count(*) b from bookings");
    assert.equal(n?.b, "1");
  });
});

describe("shared capacity and tables", () => {
  test("a shared resource (group class) takes bookings until its seats run out", async () => {
    const s = await seedSalon(env, { resources: 0 });
    const classId = await tx(env, ctxFor(s.tenantId), (c) =>
      insert(c, "resources", { tenant_id: s.tenantId, location_id: s.locationId, type: "staff", name: "Yoga room", allocation_mode: "shared", capacity_units: 4 }),
    );
    const ctx = ctxFor(s.tenantId);
    const h = (partySize: number, startsAt = at(0)) => tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: classId, partySize, startsAt })));
    await h(3);
    await h(1);
    await expectAppError(h(1), ErrorCode.BOOKING_SLOT_TAKEN);
    await h(1, at(60)); // next hour has seats
    // Availability agrees: 1 seat at 10:00 is gone, 2 seats at 11:00 are free.
    const av = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: "2031-01-06", catalogueItemId: s.serviceId, resourceId: classId, partySize: 1 }));
    const starts = av.slots.map((x) => x.startsAt);
    assert.ok(!starts.includes(at(0)), "10:00 is full");
    assert.ok(!starts.includes(at(60)) === false, "11:00 still has seats");
    const av3 = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: "2031-01-06", catalogueItemId: s.serviceId, resourceId: classId, partySize: 4 }));
    assert.ok(!av3.slots.map((x) => x.startsAt).includes(at(60)), "4 seats no longer fit at 11:00");
  });

  test("party size larger than the shared capacity is refused", async () => {
    const s = await seedSalon(env, { resources: 0 });
    const classId = await tx(env, ctxFor(s.tenantId), (c) =>
      insert(c, "resources", { tenant_id: s.tenantId, location_id: s.locationId, type: "staff", name: "Mat room", allocation_mode: "shared", capacity_units: 4 }),
    );
    const ctx = ctxFor(s.tenantId);
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: classId, partySize: 5 }))),
      ErrorCode.VALIDATION_FAILED,
    );
  });

  test("restaurant tables: the party must fit; the engine picks a table that fits; two tables can be joined", async () => {
    const s = await seedSalon(env, { pack: "restaurant", resources: 0, resourceType: "table" });
    const mk = (name: string, cap: number, min = 1) =>
      tx(env, ctxFor(s.tenantId), (c) =>
        insert(c, "resources", { tenant_id: s.tenantId, location_id: s.locationId, type: "table", name, capacity_units: cap, min_units: min }),
      );
    const t2 = await mk("T1 (2 seats)", 2);
    const t4 = await mk("T2 (4 seats)", 4);
    const t6 = await mk("T3 (6 seats)", 6, 4);
    const ctx = ctxFor(s.tenantId);
    const book = (extra: Record<string, unknown>) =>
      tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(0), durationMinutes: 90, ...extra }));

    const four = await book({ partySize: 4 });
    assert.equal(four.booking.resourceId, t4, "first table (by name) that seats 4 is T2");
    const five = await book({ partySize: 5 });
    assert.equal(five.booking.resourceId, t6, "only the 6 seater takes 5");
    await expectAppError(book({ partySize: 7 }), ErrorCode.BOOKING_SLOT_TAKEN, (e) => assert.equal(e.details.reason, "no_resource"));
    // Join T1 and T2... T2 is busy. Join with a free pair at another time.
    const joined = await tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(120), durationMinutes: 90, partySize: 6, resourceIds: [t2, t4] }));
    assert.deepEqual(joined.booking.resourceIds, [t2, t4].sort());
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(240), durationMinutes: 90, partySize: 7, resourceIds: [t2, t4] })),
      ErrorCode.VALIDATION_FAILED,
    );
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(240), durationMinutes: 90, partySize: 3, resourceIds: [t6] })),
      ErrorCode.VALIDATION_FAILED,
      (e) => assert.equal(e.details.reason, "party_size"),
    );
  });
});

describe("idempotency at engine level", () => {
  test("same key and same input returns the same booking and writes nothing new", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const input = hold(s, { resourceId: s.resourceIds[0] });
    const first = await tx(env, ctxFor(s.tenantId, { key: "idem-key-0001" }), (c) => createHold(c, ctxFor(s.tenantId, { key: "idem-key-0001" }), input));
    const again = await tx(env, ctxFor(s.tenantId, { key: "idem-key-0001" }), (c) => createHold(c, ctxFor(s.tenantId, { key: "idem-key-0001" }), input));
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.equal(again.booking.id, first.booking.id);
    assert.equal(again.booking.version, first.booking.version);
    const [n] = await rowsOf<{ b: string }>(env, s.tenantId, "select count(*) b from bookings");
    assert.equal(n?.b, "1");
    assert.deepEqual(await outboxTypes(env, s.tenantId), ["booking.created"]);
  });

  test("same key with different input is IDEMPOTENCY_CONFLICT", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId, { key: "idem-key-0002" });
    await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: s.resourceIds[0] })));
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: s.resourceIds[0], startsAt: at(120) }))),
      ErrorCode.IDEMPOTENCY_CONFLICT,
    );
  });

  test("two concurrent calls with the same key produce one booking and the same answer", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const input = hold(s);
    const run = () => {
      const ctx = ctxFor(s.tenantId, { key: "idem-key-0003" });
      return tx(env, ctx, (c) => createHold(c, ctx, input));
    };
    const [a, b] = await Promise.all([run(), run()]);
    assert.equal(a.booking.id, b.booking.id);
    assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
    const [n] = await rowsOf<{ b: string }>(env, s.tenantId, "select count(*) b from bookings");
    assert.equal(n?.b, "1");
  });

  test("a failed call does not burn the key: a retry can still succeed", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const r = s.resourceIds[0] as string;
    const blocker = ctxFor(s.tenantId);
    const held = await tx(env, blocker, (c) => createHold(c, blocker, hold(s, { resourceId: r })));
    const ctx = ctxFor(s.tenantId, { key: "idem-key-0004" });
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r }))), ErrorCode.BOOKING_SLOT_TAKEN);
    await tx(env, blocker, (c) => expireHolds(c, ctxFor(s.tenantId, { now: new Date(Date.parse(held.booking.holdExpiresAt as string) + 1000) })));
    const ok = await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r })));
    assert.equal(ok.replayed, false);
  });

  test("a malformed key is rejected", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId, { key: "short" });
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, hold(s))), ErrorCode.VALIDATION_FAILED);
  });
});

describe("hold expiry", () => {
  test("expireHolds frees the slot; confirm after expiry is HOLD_EXPIRED; running it again is harmless", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const r = s.resourceIds[0] as string;
    const ctx = ctxFor(s.tenantId);
    const h = await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r })));
    const expiresAt = new Date(h.booking.holdExpiresAt as string);
    assert.equal(expiresAt.getTime() - ctx.now().getTime(), 10 * 60_000, "salon pack: 10 minute hold");

    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r }))), ErrorCode.BOOKING_SLOT_TAKEN);

    const later = ctxFor(s.tenantId, { now: new Date(expiresAt.getTime() + 1000) });
    const swept = await tx(env, later, (c) => expireHolds(c, later));
    assert.deepEqual(swept, { expired: 1, bookingIds: [h.booking.id] });
    const again = await tx(env, later, (c) => expireHolds(c, later));
    assert.equal(again.expired, 0);

    const b = await tx(env, later, (c) => getBooking(c, later, { bookingId: h.booking.id }));
    assert.equal(b.status, "EXPIRED");
    assert.equal(b.version, h.booking.version + 1);
    await expectAppError(
      tx(env, later, (c) => confirmBooking(c, later, { bookingId: h.booking.id, customerId: s.customerId })),
      ErrorCode.HOLD_EXPIRED,
    );
    // The slot is free again.
    const second = await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r })));
    assert.equal(second.booking.status, "HOLD");
  });

  test("confirm past the expiry time is HOLD_EXPIRED even before the sweep ran", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    const h = await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: s.resourceIds[0] })));
    const late = ctxFor(s.tenantId, { now: new Date(Date.parse(h.booking.holdExpiresAt as string) + 1) });
    await expectAppError(
      tx(env, late, (c) => confirmBooking(c, late, { bookingId: h.booking.id, customerId: s.customerId })),
      ErrorCode.HOLD_EXPIRED,
    );
    // Right at the last moment it is still live.
    const edge = ctxFor(s.tenantId, { now: new Date(Date.parse(h.booking.holdExpiresAt as string) - 1) });
    const ok = await tx(env, edge, (c) => confirmBooking(c, edge, { bookingId: h.booking.id, customerId: s.customerId }));
    assert.equal(ok.booking.status, "CONFIRMED");
  });

  test("an unswept expired hold never blocks a new booking (database releases it on insert)", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const r = s.resourceIds[0] as string;
    const ctx = ctxFor(s.tenantId);
    const h = await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r })));
    // Make the hold expire in real database time.
    await tx(env, ctx, async (c) => {
      await c.query("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [h.booking.id]);
      await c.query("update booking_allocations set expires_at = now() - interval '1 minute' where booking_id = $1", [h.booking.id]);
    });
    const second = await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r })));
    assert.equal(second.booking.status, "HOLD");
    const old = await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: h.booking.id }));
    assert.equal(old.status, "EXPIRED");
  });

  test("the availability check does not offer a slot held by a live hold, and offers it once the hold has expired", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    const h = await tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: s.resourceIds[0] })));
    const q = { from: "2031-01-06", catalogueItemId: s.serviceId };
    const during = await tx(env, ctx, (c) => checkAvailability(c, ctx, q));
    assert.ok(!during.slots.some((x) => x.startsAt === at(0)));
    const after = ctxFor(s.tenantId, { now: new Date(Date.parse(h.booking.holdExpiresAt as string) + 1000) });
    const free = await tx(env, after, (c) => checkAvailability(c, after, q));
    assert.ok(free.slots.some((x) => x.startsAt === at(0)));
  });
});

describe("hold rules", () => {
  test("outside opening hours, on a closed day, in the past: BOOKING_SLOT_TAKEN with a reason", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const r = s.resourceIds[0] as string;
    const ctx = ctxFor(s.tenantId);
    const reason = (e: AppError) => e.details.reason;
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r, startsAt: at(-60) }))), ErrorCode.BOOKING_SLOT_TAKEN, (e) => assert.equal(reason(e), "outside_hours"));
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r, startsAt: at(9 * 60 + 30) }))), ErrorCode.BOOKING_SLOT_TAKEN, (e) => assert.equal(reason(e), "outside_hours"));
    // Sunday is closed.
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r, startsAt: at(6 * 24 * 60) }))), ErrorCode.BOOKING_SLOT_TAKEN, (e) => assert.equal(reason(e), "outside_hours"));
    const past = ctxFor(s.tenantId, { now: atDate(60) });
    await expectAppError(tx(env, past, (c) => createHold(c, past, hold(s, { resourceId: r }))), ErrorCode.BOOKING_SLOT_TAKEN, (e) => assert.equal(reason(e), "in_the_past"));
  });

  test("lead time and maximum advance bind customer channels only", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const r = s.resourceIds[0] as string;
    await tx(env, ctxFor(s.tenantId), (c) =>
      c.query(`update tenants set settings = $2::jsonb where id = $1`, [s.tenantId, JSON.stringify({ bookings: { leadTimeMinutes: 120, maxAdvanceDays: 30 } })]),
    );
    const now = atDate(-60); // 09:00 on the day
    const customer = customerCtx(s.tenantId, { now });
    const staff = ctxFor(s.tenantId, { now });
    const reasonOf = (e: AppError) => e.details.reason;
    await expectAppError(tx(env, customer, (c) => createHold(c, customer, hold(s, { resourceId: r, startsAt: at(0) }))), ErrorCode.BOOKING_SLOT_TAKEN, (e) => assert.equal(reasonOf(e), "lead_time"));
    await tx(env, customer, (c) => createHold(c, customer, hold(s, { resourceId: r, startsAt: at(60) }))); // 11:00 is 2 h ahead
    await tx(env, staff, (c) => createHold(c, staff, hold(s, { resourceId: r, startsAt: at(120) }))); // staff are not bound by lead time

    const farNow = atDate(-60 - 40 * 24 * 60);
    const farCustomer = customerCtx(s.tenantId, { now: farNow });
    await expectAppError(tx(env, farCustomer, (c) => createHold(c, farCustomer, hold(s, { resourceId: r, startsAt: at(180) }))), ErrorCode.BOOKING_SLOT_TAKEN, (e) => assert.equal(reasonOf(e), "too_far_ahead"));
    const farStaff = ctxFor(s.tenantId, { now: farNow });
    await tx(env, farStaff, (c) => createHold(c, farStaff, hold(s, { resourceId: r, startsAt: at(180) })));
  });

  test("time off, breaks and holidays close the window", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const r = s.resourceIds[0] as string;
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, async (c) => {
      await c.query("update resources set attributes = $2::jsonb where id = $1", [
        r,
        JSON.stringify({ breaks: [{ start: "13:00", end: "14:00" }], timeOff: [{ start: at(300), end: at(360) }] }),
      ]);
    });
    const tryAt = (min: number) => tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: r, startsAt: at(min) })));
    await expectAppError(tryAt(3 * 60 + 30), ErrorCode.BOOKING_SLOT_TAKEN, (e) => assert.equal(e.details.reason, "outside_hours")); // 13:30 break
    await expectAppError(tryAt(5 * 60), ErrorCode.BOOKING_SLOT_TAKEN); // 15:00 time off
    await tryAt(4 * 60); // 14:00 ok
    await tx(env, ctx, (c) => insert(c, "holidays", { tenant_id: s.tenantId, location_id: s.locationId, holiday_date: "2031-01-07", name: "Closed day" }));
    await expectAppError(tryAt(24 * 60), ErrorCode.BOOKING_SLOT_TAKEN);
  });

  test("an explicit resource that does not exist, belongs to another tenant, or cannot do the service", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const other = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: other.resourceIds[0] }))), ErrorCode.NOT_FOUND);
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: "00000000-0000-4000-8000-00000000dead" }))), ErrorCode.NOT_FOUND);
    await tx(env, ctx, (c) =>
      c.query("update resources set attributes = $2::jsonb where id = $1", [s.resourceIds[0], JSON.stringify({ serviceIds: ["00000000-0000-4000-8000-000000000001"] })]),
    );
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: s.resourceIds[0] }))),
      ErrorCode.VALIDATION_FAILED,
      (e) => assert.equal(e.details.reason, "resource_not_eligible"),
    );
    // Without naming one, nobody can do it.
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, hold(s))), ErrorCode.BOOKING_SLOT_TAKEN, (e) => assert.equal(e.details.reason, "no_resource"));
  });

  test("a hold with a customer id of another tenant is refused", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const other = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, hold(s, { resourceId: s.resourceIds[0], customerId: other.customerId }))),
      ErrorCode.NOT_FOUND,
    );
  });
});
