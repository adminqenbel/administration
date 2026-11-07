// rescheduleBooking atomicity and policy window; cancelBooking policy outcomes.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getPack } from "@qenbel/config-packs";
import { AppError, ErrorCode } from "@qenbel/shared";
import { cancelBooking, createHold, getBooking, rescheduleBooking } from "../src/index.ts";
import {
  at,
  atDate,
  book,
  connect,
  ctxFor,
  customerCtx,
  expectAppError,
  outboxTypes,
  rowsOf,
  seedSalon,
  tx,
  type Env,
} from "./helpers.ts";

let env: Env;
before(async () => {
  env = await connect();
});
after(async () => {
  await env.close();
});

const setSettings = (s: { tenantId: string }, bookings: Record<string, unknown>) =>
  tx(env, ctxFor(s.tenantId), (c) => c.query("update tenants set settings = $2::jsonb where id = $1", [s.tenantId, JSON.stringify({ bookings })]));

describe("rescheduleBooking", () => {
  test("moves a confirmed booking: new time, version bump, old slot freed, new slot taken, history kept", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const ctx = ctxFor(s.tenantId);
    const res = await tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(240), expectedVersion: b.version }));
    assert.equal(res.booking.startsAt, at(240));
    assert.equal(res.booking.endsAt, at(300), "keeps its one hour");
    assert.equal(res.booking.status, "CONFIRMED");
    assert.equal(res.booking.version, b.version + 1);
    // Old slot is free, new slot is not.
    const other = await book(env, s, { minutes: 0 });
    assert.equal(other.status, "CONFIRMED");
    await expectAppError(book(env, s, { minutes: 240 }), ErrorCode.BOOKING_SLOT_TAKEN);
    const rows = await rowsOf<{ active: boolean }>(env, s.tenantId, "select active from booking_allocations where booking_id = $1 order by created_at, id", [b.id]);
    assert.deepEqual(rows.map((r) => r.active), [false, true], "the old allocation is kept, released");
    assert.deepEqual(await outboxTypes(env, s.tenantId).then((t) => t.filter((x) => x === "booking.rescheduled")), ["booking.rescheduled"]);
  });

  test("a small shift that overlaps the booking's own old slot works", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const ctx = ctxFor(s.tenantId);
    const res = await tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(30), expectedVersion: b.version }));
    assert.equal(res.booking.startsAt, at(30));
  });

  test("new length via durationMinutes or endsAt; moving to another resource", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const b = await book(env, s);
    const ctx = ctxFor(s.tenantId);
    const r1 = await tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(60), durationMinutes: 90, expectedVersion: b.version }));
    assert.equal(r1.booking.endsAt, at(150));
    const r2 = await tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(60), endsAt: at(120), resourceId: s.resourceIds[1], expectedVersion: r1.booking.version }));
    assert.deepEqual(r2.booking.resourceIds, [s.resourceIds[1]]);
    assert.equal(r2.booking.endsAt, at(120));
    // The first resource is free again at that time.
    const free = await book(env, s, { minutes: 60, resourceId: s.resourceIds[0] });
    assert.equal(free.status, "CONFIRMED");
  });

  test("target taken: BOOKING_SLOT_TAKEN and the original booking is exactly as it was (rolled-back transaction)", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s, { minutes: 0 });
    await book(env, s, { minutes: 120 });
    const ctx = ctxFor(s.tenantId);
    await expectAppError(tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(120), expectedVersion: b.version })), ErrorCode.BOOKING_SLOT_TAKEN);
    await assertIntact(s.tenantId, b);
  });

  test("target taken, and the caller swallows the error and commits: the original still stands (savepoint)", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s, { minutes: 0 });
    await book(env, s, { minutes: 120 });
    const ctx = ctxFor(s.tenantId);
    let caught: unknown;
    await tx(env, ctx, async (c) => {
      await rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(120), expectedVersion: b.version }).catch((e) => {
        caught = e;
      });
    });
    assert.ok(caught instanceof AppError);
    assert.equal((caught as AppError).code, ErrorCode.BOOKING_SLOT_TAKEN);
    await assertIntact(s.tenantId, b);
  });

  test("closed hours and the past fail the same way and leave the booking intact", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s, { minutes: 0 });
    const ctx = ctxFor(s.tenantId);
    await expectAppError(
      tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(-120), expectedVersion: b.version })),
      ErrorCode.BOOKING_SLOT_TAKEN,
      (e) => assert.equal(e.details.reason, "outside_hours"),
    );
    await expectAppError(tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(6 * 24 * 60), expectedVersion: b.version })), ErrorCode.BOOKING_SLOT_TAKEN);
    await assertIntact(s.tenantId, b);
  });

  async function assertIntact(tenantId: string, before: { id: string; version: number; startsAt: string; endsAt: string }) {
    const ctx = ctxFor(tenantId);
    const now = await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: before.id }));
    assert.equal(now.version, before.version);
    assert.equal(now.startsAt, before.startsAt);
    assert.equal(now.endsAt, before.endsAt);
    assert.equal(now.status, "CONFIRMED");
    const alloc = await rowsOf<{ active: boolean; lo: Date }>(env, tenantId, "select active, lower(period) as lo from booking_allocations where booking_id = $1", [before.id]);
    assert.equal(alloc.length, 1, "no stray allocation");
    assert.equal(alloc[0]?.active, true, "old allocation still active");
    assert.equal(alloc[0]?.lo.toISOString(), before.startsAt);
    assert.equal((await outboxTypes(env, tenantId)).filter((t) => t === "booking.rescheduled").length, 0);
  }

  test("rules: version, status, resource eligibility, multi-resource", async () => {
    const s = await seedSalon(env, { resources: 3 });
    const ctx = ctxFor(s.tenantId);
    const held = await book(env, s, { confirm: false });
    await expectAppError(tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: held.id, startsAt: at(60), expectedVersion: held.version })), ErrorCode.INVALID_TRANSITION);
    const b = await book(env, s, { minutes: 120 });
    await expectAppError(tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(180), expectedVersion: b.version + 5 })), ErrorCode.VERSION_CONFLICT);
    await expectAppError(
      tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(180), resourceId: "00000000-0000-4000-8000-0000000000cc", expectedVersion: b.version })),
      ErrorCode.NOT_FOUND,
    );
    const multi = await book(env, s, { minutes: 300, resourceIds: [s.resourceIds[0] as string, s.resourceIds[1] as string] });
    const moved = await tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: multi.id, startsAt: at(420), expectedVersion: multi.version }));
    assert.deepEqual(moved.booking.resourceIds, multi.resourceIds, "keeps both resources");
    await expectAppError(
      tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: multi.id, startsAt: at(480), resourceId: s.resourceIds[2], expectedVersion: moved.booking.version })),
      ErrorCode.VALIDATION_FAILED,
    );
  });

  test("two staff moving the same booking at once: one wins, one gets VERSION_CONFLICT; the booking has one live allocation", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const run = (i: number) => {
      const ctx = ctxFor(s.tenantId);
      return tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(120 + i * 120), expectedVersion: b.version }));
    };
    const settled = await Promise.allSettled([run(0), run(1), run(2)]);
    assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of settled) if (r.status === "rejected") assert.equal((r.reason as AppError).code, ErrorCode.VERSION_CONFLICT);
    const [n] = await rowsOf<{ n: string }>(env, s.tenantId, "select count(*) n from booking_allocations where booking_id = $1 and active", [b.id]);
    assert.equal(n?.n, "1");
  });

  test("policy window: inside it, `block` refuses customer channels, staff may still move; `flag` records the late change", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const twoHoursBefore = atDate(-120);
    const customer = customerCtx(s.tenantId, { subject: { customerId: s.customerId }, now: twoHoursBefore });
    const moved = await tx(env, customer, (c) => rescheduleBooking(c, customer, { bookingId: b.id, startsAt: at(180), expectedVersion: b.version }));
    assert.equal(moved.booking.policy.lastRescheduleLate, true, "salon policy is flag: allowed, recorded");

    const s2 = await seedSalon(env, { resources: 1 });
    await setSettings(s2, { cancellationPolicy: { lateCancellation: "block", cancelUntilHoursBefore: 24 } });
    const b2 = await book(env, s2);
    const c2 = customerCtx(s2.tenantId, { subject: { customerId: s2.customerId }, now: atDate(-120) });
    await expectAppError(
      tx(env, c2, (c) => rescheduleBooking(c, c2, { bookingId: b2.id, startsAt: at(180), expectedVersion: b2.version })),
      ErrorCode.FORBIDDEN,
      (e) => assert.equal(e.details.reason, "late_change_blocked"),
    );
    const staff = ctxFor(s2.tenantId, { now: atDate(-120) });
    const ok = await tx(env, staff, (c) => rescheduleBooking(c, staff, { bookingId: b2.id, startsAt: at(180), expectedVersion: b2.version }));
    assert.equal(ok.booking.startsAt, at(180));
    // Outside the window a customer may move it.
    const early = customerCtx(s2.tenantId, { subject: { customerId: s2.customerId }, now: atDate(-60 * 24 * 5) });
    const again = await tx(env, early, (c) => rescheduleBooking(c, early, { bookingId: b2.id, startsAt: at(240), expectedVersion: ok.booking.version }));
    assert.equal(again.booking.policy.lastRescheduleLate, false);
  });

  test("idempotent replay does not move it twice or emit twice", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const mk = () => ctxFor(s.tenantId, { key: "resched-key-01" });
    const a = await tx(env, mk(), (c) => rescheduleBooking(c, mk(), { bookingId: b.id, startsAt: at(240), expectedVersion: b.version }));
    const r = await tx(env, mk(), (c) => rescheduleBooking(c, mk(), { bookingId: b.id, startsAt: at(240), expectedVersion: b.version }));
    assert.equal(r.replayed, true);
    assert.equal(r.booking.version, a.booking.version);
    assert.equal((await outboxTypes(env, s.tenantId)).filter((t) => t === "booking.rescheduled").length, 1);
  });
});

describe("cancelBooking", () => {
  test("a hold cancels for free and frees the slot", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const h = await book(env, s, { confirm: false });
    const ctx = ctxFor(s.tenantId);
    const res = await tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: h.id, reason: "Changed my mind" }));
    assert.equal(res.booking.status, "CANCELLED");
    assert.equal(res.booking.cancellationReason, "Changed my mind");
    assert.equal(res.booking.cancelledAt, ctx.now().toISOString());
    assert.equal(res.cancellation.outcome, "free");
    assert.equal(res.cancellation.feePaise, 0);
    assert.equal((await book(env, s)).status, "CONFIRMED", "the slot is free again");
  });

  test("outside the free window: free", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const ctx = ctxFor(s.tenantId, { now: atDate(-60 * 24) }); // a day before
    const res = await tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: b.id }));
    assert.equal(res.cancellation.outcome, "free");
    assert.equal(res.cancellation.late, false);
    assert.equal(res.cancellation.hoursBeforeStart, 24);
    assert.equal(res.booking.policy.cancellation && (res.booking.policy.cancellation as { outcome: string }).outcome, "free");
  });

  test("inside the window under `flag`: accepted and flagged; the fee is the forfeited deposit, refund nothing", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await setSettings(s, { deposit: { fixedPaise: 10_000 } });
    const b = await book(env, s);
    assert.equal(b.depositPaise, 10_000);
    await tx(env, ctxFor(s.tenantId), (c) => c.query("update bookings set deposit_status = 'paid' where id = $1", [b.id]));
    const ctx = ctxFor(s.tenantId, { now: atDate(-120) }); // 2 hours before; the window is 4
    const res = await tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: b.id }));
    assert.equal(res.cancellation.outcome, "late_flagged");
    assert.equal(res.cancellation.late, true);
    assert.equal(res.cancellation.feePaise, 10_000);
    assert.equal(res.cancellation.depositRefundPaise, 0);
    assert.equal(res.booking.status, "CANCELLED");
  });

  test("a fixed late fee smaller than a paid deposit refunds the rest", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await setSettings(s, { deposit: { fixedPaise: 10_000 }, cancellationPolicy: { lateFeePaise: 4_000 } });
    const b = await book(env, s);
    await tx(env, ctxFor(s.tenantId), (c) => c.query("update bookings set deposit_status = 'paid' where id = $1", [b.id]));
    const ctx = ctxFor(s.tenantId, { now: atDate(-30) });
    const res = await tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: b.id }));
    assert.equal(res.cancellation.feePaise, 4_000);
    assert.equal(res.cancellation.depositRefundPaise, 6_000);
  });

  test("inside the window under `allow` (clinic pack): accepted, no fee", async () => {
    const s = await seedSalon(env, { pack: "clinic", resources: 1, resourceType: "doctor" });
    await setSettings(s, { deposit: { fixedPaise: 10_000 } });
    const b = await book(env, s);
    assert.equal(b.policy.lateCancellation, "allow");
    assert.equal(b.policy.cancelUntilHoursBefore, 6);
    const ctx = ctxFor(s.tenantId, { now: atDate(-120) });
    const res = await tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: b.id }));
    assert.equal(res.cancellation.outcome, "late_allowed");
    assert.equal(res.cancellation.feePaise, 0);
  });

  test("`block`: customer channels are refused and nothing changes; staff may cancel and it is treated as flagged", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await setSettings(s, { cancellationPolicy: { lateCancellation: "block", cancelUntilHoursBefore: 24, lateFeePaise: 2_500 } });
    const b = await book(env, s);
    const customer = customerCtx(s.tenantId, { subject: { customerId: s.customerId }, now: atDate(-120) });
    const err = await expectAppError(tx(env, customer, (c) => cancelBooking(c, customer, { bookingId: b.id })), ErrorCode.FORBIDDEN);
    assert.equal(err.details.reason, "late_cancellation_blocked");
    const ctx = ctxFor(s.tenantId);
    assert.equal((await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: b.id }))).status, "CONFIRMED");
    const staff = ctxFor(s.tenantId, { now: atDate(-120) });
    const res = await tx(env, staff, (c) => cancelBooking(c, staff, { bookingId: b.id }));
    assert.equal(res.cancellation.outcome, "late_flagged");
    assert.equal(res.cancellation.feePaise, 2_500);
    // A customer outside the window may cancel.
    const b2 = await book(env, s, { minutes: 120 });
    const early = customerCtx(s.tenantId, { subject: { customerId: s.customerId }, now: atDate(-60 * 72) });
    assert.equal((await tx(env, early, (c) => cancelBooking(c, early, { bookingId: b2.id }))).cancellation.outcome, "free");
  });

  test("the rules in force at confirmation apply, not the ones changed since (snapshot)", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s); // snapshot: 4 hours, flag
    await setSettings(s, { cancellationPolicy: { cancelUntilHoursBefore: 100, lateCancellation: "block" } });
    const customer = customerCtx(s.tenantId, { subject: { customerId: s.customerId }, now: atDate(-60 * 10) }); // 10 hours before: free under the snapshot
    const res = await tx(env, customer, (c) => cancelBooking(c, customer, { bookingId: b.id }));
    assert.equal(res.cancellation.outcome, "free");
    assert.equal(res.cancellation.cancelUntilHoursBefore, 4);
  });

  test("after the start time a cancellation is late", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const ctx = ctxFor(s.tenantId, { now: atDate(30) });
    const res = await tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: b.id }));
    assert.equal(res.cancellation.late, true);
    assert.ok(res.cancellation.hoursBeforeStart < 0);
  });

  test("cancelling twice is INVALID_TRANSITION; with the same key it replays the first answer once", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: b.id }));
    await expectAppError(tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: b.id })), ErrorCode.INVALID_TRANSITION);

    const b2 = await book(env, s, { minutes: 120 });
    const k = () => ctxFor(s.tenantId, { key: "cancel-key-01" });
    const one = await tx(env, k(), (c) => cancelBooking(c, k(), { bookingId: b2.id }));
    const two = await tx(env, k(), (c) => cancelBooking(c, k(), { bookingId: b2.id }));
    assert.equal(two.replayed, true);
    assert.deepEqual(two.cancellation, one.cancellation);
    assert.equal((await outboxTypes(env, s.tenantId)).filter((t) => t === "booking.cancelled").length, 2, "one per booking");
  });

  test("a cancelled multi-resource booking frees every resource", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const b = await book(env, s, { resourceIds: s.resourceIds });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: b.id }));
    const [n] = await rowsOf<{ n: string }>(env, s.tenantId, "select count(*) n from booking_allocations where active");
    assert.equal(n?.n, "0");
    const after = await getBookingResources(s.tenantId, b.id);
    assert.deepEqual(after, [...s.resourceIds].sort(), "the booking still shows what it had");
  });

  async function getBookingResources(tenantId: string, id: string) {
    const ctx = ctxFor(tenantId);
    return (await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: id }))).resourceIds;
  }

  test("a hold is not charged: cancelling a HOLD ignores the window even for `block`", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await setSettings(s, { cancellationPolicy: { lateCancellation: "block", cancelUntilHoursBefore: 720 } });
    const ctx0 = ctxFor(s.tenantId);
    const h = await tx(env, ctx0, (c) => createHold(c, ctx0, { startsAt: at(0), catalogueItemId: s.serviceId, customerId: s.customerId }));
    const customer = customerCtx(s.tenantId, { subject: { customerId: s.customerId }, now: atDate(-30) });
    const res = await tx(env, customer, (c) => cancelBooking(c, customer, { bookingId: h.booking.id }));
    assert.equal(res.cancellation.outcome, "free");
    void getPack;
  });
});
