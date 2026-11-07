// Outbox and audit, tenant isolation per function, smuggled tenant ids, listing and paging.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ErrorCode, type EngineContext } from "@qenbel/shared";
import {
  cancelBooking,
  checkAvailability,
  checkIn,
  complete,
  confirmBooking,
  createHold,
  expireHolds,
  getBooking,
  listBookingEvents,
  listBookings,
  markNoShow,
  rescheduleBooking,
  transitionBooking,
} from "../src/index.ts";
import { at, atDate, book, connect, ctxFor, expectAppError, outboxTypes, rowsOf, seedSalon, tx, type Env } from "./helpers.ts";

let env: Env;
before(async () => {
  env = await connect();
});
after(async () => {
  await env.close();
});

describe("outbox events and audit", () => {
  test("a full life writes each event exactly once, in order, with the actor", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const staff = ctxFor(s.tenantId, { actorId: "user-42" });
    const b = await book(env, s, { ctx: staff });
    const moved = await tx(env, staff, (c) => rescheduleBooking(c, staff, { bookingId: b.id, startsAt: at(120), expectedVersion: b.version }));
    const inn = await tx(env, staff, (c) => checkIn(c, staff, { bookingId: b.id, expectedVersion: moved.booking.version }));
    await tx(env, staff, (c) => complete(c, staff, { bookingId: b.id, expectedVersion: inn.booking.version }));

    const c2 = await book(env, s, { minutes: 300, ctx: staff });
    await tx(env, staff, (c) => cancelBooking(c, staff, { bookingId: c2.id }));
    const n = await book(env, s, { minutes: 420, ctx: staff });
    const late = ctxFor(s.tenantId, { now: atDate(420 + 10) });
    await tx(env, late, (c) => markNoShow(c, late, { bookingId: n.id, expectedVersion: n.version }));

    const types = await outboxTypes(env, s.tenantId);
    assert.deepEqual(types, [
      "booking.created", "booking.confirmed", "booking.rescheduled", "booking.completed",
      "booking.created", "booking.confirmed", "booking.cancelled",
      "booking.created", "booking.confirmed", "booking.no_show",
    ]);
    const payloads = await rowsOf<{ type: string; aggregate_type: string; aggregate_id: string; payload: Record<string, unknown>; status: string }>(
      env, s.tenantId, "select type, aggregate_type, aggregate_id, payload, status from outbox_events where type = 'booking.rescheduled'",
    );
    assert.equal(payloads.length, 1);
    const p = payloads[0]!;
    assert.equal(p.aggregate_type, "booking");
    assert.equal(p.aggregate_id, b.id);
    assert.equal(p.status, "pending");
    assert.equal(p.payload.bookingId, b.id);
    assert.equal(p.payload.startsAt, at(120));
    assert.equal(p.payload.previousStatus, "CONFIRMED");
    assert.deepEqual(p.payload.actor, { kind: "user", id: "user-42", channel: "dashboard" });
    assert.ok(!("notes" in p.payload), "no free text in events");
    const ids = await rowsOf<{ n: string; d: string }>(env, s.tenantId, "select count(*) n, count(distinct event_id) d from outbox_events");
    assert.equal(ids[0]?.n, ids[0]?.d, "every event has its own eventId");
  });

  test("events and audit roll back with the transaction: nothing is left when the caller fails", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    await assert.rejects(
      tx(env, ctx, async (c) => {
        const h = await createHold(c, ctx, { startsAt: at(0), catalogueItemId: s.serviceId });
        await confirmBooking(c, ctx, { bookingId: h.booking.id, customerId: s.customerId });
        throw new Error("the API failed after the engine");
      }),
      /the API failed/,
    );
    assert.deepEqual(await outboxTypes(env, s.tenantId), []);
    const [n] = await rowsOf<{ b: string; a: string; l: string }>(
      env, s.tenantId,
      "select (select count(*) from bookings) b, (select count(*) from booking_allocations) a, (select count(*) from audit_log) l",
    );
    assert.deepEqual([n?.b, n?.a, n?.l], ["0", "0", "0"]);
    // And the slot really is free.
    assert.equal((await book(env, s)).status, "CONFIRMED");
  });

  test("a failed engine call writes no events", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const before = (await outboxTypes(env, s.tenantId)).length;
    const ctx = ctxFor(s.tenantId);
    await expectAppError(tx(env, ctx, (c) => complete(c, ctx, { bookingId: b.id, expectedVersion: b.version })), ErrorCode.INVALID_TRANSITION);
    assert.equal((await outboxTypes(env, s.tenantId)).length, before);
  });

  test("the timeline records who did what from which channel; check-in is audited but has no webhook event", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const agent = ctxFor(s.tenantId, { channel: "whatsapp", kind: "api_credential", actorId: "cred-9", subject: { customerId: s.customerId } });
    const b = await book(env, s, { ctx: agent });
    const staff = ctxFor(s.tenantId, { actorId: "user-1" });
    await tx(env, staff, (c) => checkIn(c, staff, { bookingId: b.id, expectedVersion: b.version }));
    const timeline = await tx(env, staff, (c) => listBookingEvents(c, staff, { bookingId: b.id }));
    assert.deepEqual(timeline.map((t) => t.action), ["booking.hold", "booking.confirm", "booking.check_in"]);
    assert.deepEqual(timeline.map((t) => [t.actorKind, t.actorId, t.channel]), [
      ["api_credential", "cred-9", "whatsapp"],
      ["api_credential", "cred-9", "whatsapp"],
      ["user", "user-1", "dashboard"],
    ]);
    assert.equal(timeline[2]?.details.fromStatus, "CONFIRMED");
    assert.equal(timeline[2]?.details.toStatus, "CHECKED_IN");
    assert.ok(!(await outboxTypes(env, s.tenantId)).some((t) => t.includes("check")));
  });

  test("expiry is audited with the system actor and queues one booking.expired event", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const h = await book(env, s, { confirm: false });
    const job = ctxFor(s.tenantId, { kind: "system", actorId: "hold-expiry", now: new Date(Date.parse(h.holdExpiresAt as string) + 1000) });
    await tx(env, job, (c) => expireHolds(c, job));
    const timeline = await tx(env, job, (c) => listBookingEvents(c, job, { bookingId: h.id }));
    assert.deepEqual(timeline.map((t) => t.action), ["booking.hold", "booking.expire"]);
    assert.equal(timeline[1]?.actorKind, "system");
    assert.deepEqual(await outboxTypes(env, s.tenantId), ["booking.created", "booking.expired"]);
    const [ev] = await rowsOf<{ aggregate_id: string; payload: Record<string, unknown> }>(env, s.tenantId, "select aggregate_id, payload from outbox_events where type = 'booking.expired'");
    assert.equal(ev?.aggregate_id, h.id);
    assert.equal(ev?.payload.status, "EXPIRED");
    assert.equal(ev?.payload.previousStatus, "HOLD");
    assert.equal(ev?.payload.version, h.version + 1);
    assert.deepEqual(ev?.payload.actor, { kind: "system", id: "hold-expiry", channel: "dashboard" });
    // A second run finds nothing: still exactly one event.
    const again = await tx(env, job, (c) => expireHolds(c, job));
    assert.equal(again.expired, 0);
    assert.deepEqual(await outboxTypes(env, s.tenantId), ["booking.created", "booking.expired"]);
  });
});

describe("tenant isolation, function by function", () => {
  test("tenant A cannot read or change tenant B's booking through any function; B's booking is untouched", async () => {
    const a = await seedSalon(env, { resources: 1 });
    const b = await seedSalon(env, { resources: 1 });
    const bBooking = await book(env, b);
    const bHold = await book(env, b, { minutes: 120, confirm: false });
    const ctx = ctxFor(a.tenantId, { now: atDate(60) });
    const id = bBooking.id;
    const v = bBooking.version;
    const calls: Record<string, () => Promise<unknown>> = {
      getBooking: () => tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: id })),
      listBookingEvents: () => tx(env, ctx, (c) => listBookingEvents(c, ctx, { bookingId: id })),
      confirmBooking: () => tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: bHold.id, customerId: a.customerId })),
      rescheduleBooking: () => tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: id, startsAt: at(300), expectedVersion: v })),
      cancelBooking: () => tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: id })),
      checkIn: () => tx(env, ctx, (c) => checkIn(c, ctx, { bookingId: id, expectedVersion: v })),
      complete: () => tx(env, ctx, (c) => complete(c, ctx, { bookingId: id, expectedVersion: v })),
      markNoShow: () => tx(env, ctx, (c) => markNoShow(c, ctx, { bookingId: id, expectedVersion: v })),
      transitionBooking: () => tx(env, ctx, (c) => transitionBooking(c, ctx, { bookingId: id, to: "CHECKED_IN", expectedVersion: v })),
    };
    for (const [name, call] of Object.entries(calls)) {
      await expectAppError(call(), ErrorCode.NOT_FOUND).catch((e) => {
        throw new Error(`${name}: ${(e as Error).message}`);
      });
    }
    const cb = ctxFor(b.tenantId);
    const after = await tx(env, cb, (c) => getBooking(c, cb, { bookingId: id }));
    assert.equal(after.version, v);
    assert.equal(after.status, "CONFIRMED");
    assert.equal((await tx(env, cb, (c) => getBooking(c, cb, { bookingId: bHold.id }))).status, "HOLD");
    // Same error body as an id that does not exist.
    const ghost = await expectAppError(tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: "00000000-0000-4000-8000-0000000000ee" })), ErrorCode.NOT_FOUND);
    const foreign = await expectAppError(tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: id })), ErrorCode.NOT_FOUND);
    assert.deepEqual(foreign.toBody(), ghost.toBody());
  });

  test("listBookings shows only the caller's tenant, and a foreign resource or customer filter finds nothing", async () => {
    const a = await seedSalon(env, { resources: 1 });
    const b = await seedSalon(env, { resources: 1 });
    await book(env, a);
    const bb = await book(env, b);
    const ctx = ctxFor(a.tenantId);
    const all = await tx(env, ctx, (c) => listBookings(c, ctx, {}));
    assert.equal(all.items.length, 1);
    assert.ok(all.items.every((x) => x.id !== bb.id));
    const byForeignResource = await tx(env, ctx, (c) => listBookings(c, ctx, { resourceId: b.resourceIds[0] }));
    assert.equal(byForeignResource.items.length, 0);
    const byForeignCustomer = await tx(env, ctx, (c) => listBookings(c, ctx, { customerId: b.customerId }));
    assert.equal(byForeignCustomer.items.length, 0);
  });

  test("expireHolds in one tenant leaves another tenant's expired hold alone", async () => {
    const a = await seedSalon(env, { resources: 1 });
    const b = await seedSalon(env, { resources: 1 });
    const ha = await book(env, a, { confirm: false });
    const hb = await book(env, b, { confirm: false });
    const later = (t: string) => ctxFor(t, { now: new Date(Date.parse(ha.holdExpiresAt as string) + 60_000) });
    const ctxA = later(a.tenantId);
    const res = await tx(env, ctxA, (c) => expireHolds(c, ctxA));
    assert.deepEqual(res.bookingIds, [ha.id]);
    const ctxB = later(b.tenantId);
    assert.equal((await tx(env, ctxB, (c) => getBooking(c, ctxB, { bookingId: hb.id }))).status, "HOLD");
  });

  test("a context for one tenant on a connection scoped to another is refused by every function", async () => {
    const a = await seedSalon(env, { resources: 1 });
    const b = await seedSalon(env, { resources: 1 });
    const bBooking = await book(env, b);
    const wrong = ctxFor(b.tenantId);
    const onA = (fn: (c: Parameters<Parameters<typeof tx>[2]>[0]) => Promise<unknown>) => tx(env, ctxFor(a.tenantId), fn);
    const id = bBooking.id;
    const calls: (() => Promise<unknown>)[] = [
      () => onA((c) => checkAvailability(c, wrong, { from: "2031-01-06" })),
      () => onA((c) => createHold(c, wrong, { startsAt: at(300), durationMinutes: 30 })),
      () => onA((c) => confirmBooking(c, wrong, { bookingId: id, customerId: b.customerId })),
      () => onA((c) => rescheduleBooking(c, wrong, { bookingId: id, startsAt: at(60), expectedVersion: 1 })),
      () => onA((c) => cancelBooking(c, wrong, { bookingId: id })),
      () => onA((c) => checkIn(c, wrong, { bookingId: id, expectedVersion: 1 })),
      () => onA((c) => complete(c, wrong, { bookingId: id, expectedVersion: 1 })),
      () => onA((c) => markNoShow(c, wrong, { bookingId: id, expectedVersion: 1 })),
      () => onA((c) => getBooking(c, wrong, { bookingId: id })),
      () => onA((c) => listBookings(c, wrong, {})),
      () => onA((c) => listBookingEvents(c, wrong, { bookingId: id })),
      () => onA((c) => expireHolds(c, wrong)),
    ];
    for (const call of calls) await expectAppError(call(), ErrorCode.TENANT_REQUIRED);
  });
});

describe("smuggled tenant ids and roles are rejected", () => {
  test("every function refuses tenantId, tenant_id and role in its input", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const ctx = ctxFor(s.tenantId);
    const id = b.id;
    for (const extra of [{ tenantId: s.tenantId }, { tenant_id: s.tenantId }, { role: "OWNER" }, { orgId: s.tenantId }]) {
      const calls: Record<string, () => Promise<unknown>> = {
        checkAvailability: () => tx(env, ctx, (c) => checkAvailability(c, ctx, { from: "2031-01-06", ...extra })),
        createHold: () => tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(300), durationMinutes: 30, ...extra })),
        confirmBooking: () => tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: id, customerId: s.customerId, ...extra })),
        rescheduleBooking: () => tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: id, startsAt: at(60), expectedVersion: 2, ...extra })),
        cancelBooking: () => tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: id, ...extra })),
        checkIn: () => tx(env, ctx, (c) => checkIn(c, ctx, { bookingId: id, expectedVersion: 2, ...extra })),
        complete: () => tx(env, ctx, (c) => complete(c, ctx, { bookingId: id, expectedVersion: 2, ...extra })),
        markNoShow: () => tx(env, ctx, (c) => markNoShow(c, ctx, { bookingId: id, expectedVersion: 2, ...extra })),
        transitionBooking: () => tx(env, ctx, (c) => transitionBooking(c, ctx, { bookingId: id, to: "CHECKED_IN", expectedVersion: 2, ...extra })),
        getBooking: () => tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: id, ...extra })),
        listBookings: () => tx(env, ctx, (c) => listBookings(c, ctx, { ...extra })),
        listBookingEvents: () => tx(env, ctx, (c) => listBookingEvents(c, ctx, { bookingId: id, ...extra })),
        expireHolds: () => tx(env, ctx, (c) => expireHolds(c, ctx, { ...extra })),
      };
      for (const [name, call] of Object.entries(calls)) {
        await expectAppError(call(), ErrorCode.VALIDATION_FAILED).catch((e) => {
          throw new Error(`${name} ${JSON.stringify(extra)}: ${(e as Error).message}`);
        });
      }
    }
    // The booking and the tenant's data were not touched by any of it.
    assert.equal((await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: id }))).version, b.version);
  });

  test("a tenant id inside nested customer details is rejected too", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const h = await book(env, s, { confirm: false });
    const ctx = ctxFor(s.tenantId);
    await expectAppError(
      tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h.id, customer: { name: "A", phone: "9876543210", tenantId: s.tenantId } })),
      ErrorCode.VALIDATION_FAILED,
    );
  });
});

describe("listBookings", () => {
  test("pages are stable and complete: no skips, no repeats, even with equal start times", async () => {
    const s = await seedSalon(env, { resources: 3 });
    const made: string[] = [];
    for (let i = 0; i < 7; i++) made.push((await book(env, s, { minutes: Math.floor(i / 3) * 60, resourceId: s.resourceIds[i % 3] as string })).id);
    const ctx = ctxFor(s.tenantId);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await tx(env, ctx, (c) => listBookings(c, ctx, { limit: 3, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.items.map((x) => x.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual([...seen].sort(), [...made].sort());
    assert.equal(new Set(seen).size, 7);
    const starts = (await tx(env, ctx, (c) => listBookings(c, ctx, { limit: 100 }))).items.map((x) => x.startsAt);
    assert.deepEqual(starts, [...starts].sort());
  });

  test("filters: status, resource, customer, channel, from/to, local date", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const web = ctxFor(s.tenantId, { channel: "web_chat", kind: "api_credential", actorId: "w", subject: { customerId: s.customerId } });
    const a = await book(env, s, { minutes: 0, resourceId: s.resourceIds[0] as string });
    const b = await book(env, s, { minutes: 120, resourceId: s.resourceIds[1] as string, ctx: web });
    const c3 = await book(env, s, { minutes: 24 * 60, resourceId: s.resourceIds[0] as string, confirm: false });
    const ctx = ctxFor(s.tenantId);
    const ids = async (q: Record<string, unknown>) => (await tx(env, ctx, (c) => listBookings(c, ctx, q))).items.map((x) => x.id).sort();
    assert.deepEqual(await ids({ status: "HOLD" }), [c3.id]);
    assert.deepEqual(await ids({ status: "CONFIRMED" }), [a.id, b.id].sort());
    assert.deepEqual(await ids({ resourceId: s.resourceIds[1] }), [b.id]);
    assert.deepEqual(await ids({ customerId: s.customerId }), [a.id, b.id].sort());
    assert.deepEqual(await ids({ channel: "web_chat" }), [b.id]);
    assert.deepEqual(await ids({ from: at(60), to: at(24 * 60) }), [b.id], "start in [from, to)");
    assert.deepEqual(await ids({ date: "2031-01-06" }), [a.id, b.id].sort());
    assert.deepEqual(await ids({ date: "2031-01-07" }), [c3.id]);
    assert.deepEqual(await ids({ date: "2031-01-08" }), []);
    // The local day boundary is the location's: 2031-01-06 00:00 IST is 2031-01-05 18:30 UTC.
    const cancelled = await tx(env, ctx, (cx) => cancelBooking(cx, ctx, { bookingId: a.id }));
    assert.equal(cancelled.booking.status, "CANCELLED");
    assert.deepEqual(await ids({ resourceId: s.resourceIds[0], status: "CANCELLED" }), [a.id], "history keeps the resource after release");
  });

  test("bad input: limit over 100, from after to, date with from, malformed or foreign-filter cursors", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await book(env, s);
    await book(env, s, { minutes: 60 });
    const ctx = ctxFor(s.tenantId);
    const list = (q: Record<string, unknown>) => tx(env, ctx, (c) => listBookings(c, ctx, q));
    await expectAppError(list({ limit: 101 }), ErrorCode.VALIDATION_FAILED);
    await expectAppError(list({ limit: 0 }), ErrorCode.VALIDATION_FAILED);
    await expectAppError(list({ from: at(60), to: at(0) }), ErrorCode.VALIDATION_FAILED);
    await expectAppError(list({ date: "2031-01-06", from: at(0) }), ErrorCode.VALIDATION_FAILED);
    await expectAppError(list({ cursor: "not-a-cursor" }), ErrorCode.VALIDATION_FAILED);
    const page = await list({ limit: 1 });
    assert.ok(page.nextCursor);
    await expectAppError(list({ limit: 1, status: "HOLD", cursor: page.nextCursor as string }), ErrorCode.VALIDATION_FAILED);
    // A cursor from another tenant is refused as well.
    const other = await seedSalon(env, { resources: 1 });
    await book(env, other);
    await book(env, other, { minutes: 60 });
    const oc = ctxFor(other.tenantId);
    const foreign = await tx(env, oc, (c) => listBookings(c, oc, { limit: 1 }));
    await expectAppError(list({ limit: 1, cursor: foreign.nextCursor as string }), ErrorCode.VALIDATION_FAILED);
    const ok = await list({ limit: 1, cursor: page.nextCursor as string });
    assert.equal(ok.items.length, 1);
    assert.equal(ok.nextCursor, null);
  });

  test("getBooking returns the full view", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const ctx = ctxFor(s.tenantId);
    const got = await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: b.id }));
    assert.deepEqual(got, b);
    assert.equal(got.reference.length, 8);
    assert.equal(got.source, "dashboard");
    assert.equal(got.locationId, s.locationId);
  });
});

void (null as unknown as EngineContext);
