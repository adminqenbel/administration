// confirm_booking and the status machine: every legal and illegal transition through the engine, pack narrowing, versions.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getPack } from "@qenbel/config-packs";
import { BookingStatus, ErrorCode, bookingMachine, bookingTransitionsWithout, canTransition, type ConfigPack } from "@qenbel/shared";
import {
  cancelBooking,
  checkIn,
  complete,
  confirmBooking,
  createHold,
  expireHolds,
  getBooking,
  markNoShow,
  rescheduleBooking,
  transitionBooking,
  type BookingView,
} from "../src/index.ts";
import { at, atDate, book, connect, ctxFor, expectAppError, insert, outboxTypes, rowsOf, seedSalon, tx, type Env, type Salon } from "./helpers.ts";

let env: Env;
before(async () => {
  env = await connect();
});
after(async () => {
  await env.close();
});

describe("confirmBooking", () => {
  test("confirms a live hold: status, version, customer, cleared expiry, policy and deposit snapshot", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await tx(env, ctxFor(s.tenantId), (c) =>
      c.query("update tenants set settings = $2::jsonb where id = $1", [s.tenantId, JSON.stringify({ bookings: { deposit: { percentBps: 2000 } } })]),
    );
    const held = await book(env, s, { confirm: false });
    assert.equal(held.status, "HOLD");
    assert.ok(held.holdExpiresAt);
    const ctx = ctxFor(s.tenantId);
    const { booking, replayed } = await tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: held.id, customerId: s.customerId, notes: "Window seat please" }));
    assert.equal(replayed, false);
    assert.equal(booking.status, "CONFIRMED");
    assert.equal(booking.version, held.version + 1);
    assert.equal(booking.customerId, s.customerId);
    assert.equal(booking.holdExpiresAt, null);
    assert.equal(booking.confirmedAt, ctx.now().toISOString());
    assert.equal(booking.notes, "Window seat please");
    assert.equal(booking.depositPaise, 10_000, "20% of 50,000 paise");
    assert.equal(booking.depositStatus, "unpaid");
    assert.equal(booking.policy.cancelUntilHoursBefore, 4);
    assert.equal(booking.policy.lateCancellation, "flag");
    assert.equal(booking.policy.packId, "salon");
    const [alloc] = await rowsOf<{ expires_at: Date | null; active: boolean }>(env, s.tenantId, "select expires_at, active from booking_allocations where booking_id = $1", [held.id]);
    assert.equal(alloc?.expires_at, null, "the allocation no longer expires");
    assert.equal(alloc?.active, true);
  });

  test("a service's own deposit beats the tenant percentage", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await tx(env, ctxFor(s.tenantId), async (c) => {
      await c.query("update tenants set settings = $2::jsonb where id = $1", [s.tenantId, JSON.stringify({ bookings: { deposit: { percentBps: 2000 } } })]);
      await c.query("update catalogue_items set attributes = $2::jsonb where id = $1", [s.serviceId, JSON.stringify({ depositPaise: 7500 })]);
    });
    const b = await book(env, s);
    assert.equal(b.depositPaise, 7500);
  });

  test("new customer details: required fields are checked, the phone is normalised, a repeat phone reuses the customer", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    const h1 = await book(env, s, { confirm: false });
    const noPhone = await expectAppError(
      tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h1.id, customer: { name: "Meera Test" } })),
      ErrorCode.REQUIRED_FIELDS_MISSING,
    );
    assert.deepEqual(noPhone.details.missing, ["phone"]);
    const [still] = await rowsOf<{ status: string }>(env, s.tenantId, "select status from bookings where id = $1", [h1.id]);
    assert.equal(still?.status, "HOLD", "nothing changed");

    const ok = await tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h1.id, customer: { name: "Meera Test", phone: "98765 43210", dateOfBirth: "1990-02-03", notes: "Prefers mornings" } }));
    const [cust] = await rowsOf<{ phone: string; attributes: { dateOfBirth?: string }; source: string }>(env, s.tenantId, "select phone, attributes, source from customers where id = $1", [ok.booking.customerId]);
    assert.equal(cust?.phone, "+919876543210");
    assert.equal(cust?.attributes.dateOfBirth, "1990-02-03");
    assert.equal(cust?.source, "dashboard");
    const [note] = await rowsOf<{ body: string }>(env, s.tenantId, "select body from customer_notes where customer_id = $1", [ok.booking.customerId]);
    assert.equal(note?.body, "Prefers mornings");
    assert.ok((await outboxTypes(env, s.tenantId)).includes("customer.created"));

    const h2 = await book(env, s, { confirm: false, minutes: 120 });
    const again = await tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h2.id, customer: { name: "Meera T.", phone: "+91 98765-43210" } }));
    assert.equal(again.booking.customerId, ok.booking.customerId, "same phone, same customer");
    const [n] = await rowsOf<{ n: string }>(env, s.tenantId, "select count(*) n from customers where phone = '+919876543210'");
    assert.equal(n?.n, "1");
    const events = await outboxTypes(env, s.tenantId);
    assert.equal(events.filter((e) => e === "customer.created").length, 1);

    const h3 = await book(env, s, { confirm: false, minutes: 240 });
    await expectAppError(
      tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h3.id, customer: { name: "X", phone: "12345" } })),
      ErrorCode.VALIDATION_FAILED,
    );
  });

  test("the pack decides which customer fields are required (an existing customer is checked too)", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const strict: ConfigPack = { ...getPack("salon"), requiredCustomerFields: ["name", "phone", "email", "dateOfBirth"] };
    const h = await book(env, s, { confirm: false });
    const ctx = ctxFor(s.tenantId);
    const err = await expectAppError(
      tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h.id, customerId: s.customerId }, { pack: strict })),
      ErrorCode.REQUIRED_FIELDS_MISSING,
    );
    assert.deepEqual(err.details.missing, ["email", "dateOfBirth"]);
    await tx(env, ctx, (c) => c.query("update customers set email = 'a@example.com', attributes = '{\"dateOfBirth\":\"1990-01-01\"}'::jsonb where id = $1", [s.customerId]));
    const ok = await tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h.id, customerId: s.customerId }, { pack: strict }));
    assert.equal(ok.booking.status, "CONFIRMED");
  });

  test("a customer of another tenant, an archived customer and an unknown booking are NOT_FOUND", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const other = await seedSalon(env, { resources: 1 });
    const h = await book(env, s, { confirm: false });
    const ctx = ctxFor(s.tenantId);
    await expectAppError(tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h.id, customerId: other.customerId })), ErrorCode.NOT_FOUND);
    await tx(env, ctx, (c) => c.query("update customers set archived_at = now() where id = $1", [s.customerId]));
    await expectAppError(tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h.id, customerId: s.customerId })), ErrorCode.NOT_FOUND);
    await expectAppError(tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: "00000000-0000-4000-8000-0000000000bb", customerId: s.customerId })), ErrorCode.NOT_FOUND);
  });

  test("input rules: exactly one of customerId / customer; strict keys", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const h = await book(env, s, { confirm: false });
    const ctx = ctxFor(s.tenantId);
    await expectAppError(tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h.id })), ErrorCode.VALIDATION_FAILED);
    await expectAppError(tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h.id, customerId: s.customerId, customer: { name: "A", phone: "9876543210" } })), ErrorCode.VALIDATION_FAILED);
    await expectAppError(tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h.id, customerId: s.customerId, status: "COMPLETED" })), ErrorCode.VALIDATION_FAILED);
    await expectAppError(tx(env, ctx, (c) => confirmBooking(c, ctx, { customerId: s.customerId })), ErrorCode.VALIDATION_FAILED);
    await expectAppError(tx(env, ctx, (c) => confirmBooking(c, ctx, "nonsense")), ErrorCode.VALIDATION_FAILED);
  });

  test("idempotent: the same key replays the confirmation without a second event", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const h = await book(env, s, { confirm: false });
    const ctx = ctxFor(s.tenantId, { key: "confirm-key-01" });
    const a = await tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h.id, customerId: s.customerId }));
    const b = await tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h.id, customerId: s.customerId }));
    assert.equal(b.replayed, true);
    assert.equal(b.booking.version, a.booking.version);
    assert.equal((await outboxTypes(env, s.tenantId)).filter((t) => t === "booking.confirmed").length, 1);
    // Without a key a second confirm is an illegal transition, not a silent success.
    const plain = ctxFor(s.tenantId);
    await expectAppError(tx(env, plain, (c) => confirmBooking(c, plain, { bookingId: h.id, customerId: s.customerId })), ErrorCode.INVALID_TRANSITION);
  });
});

// ---- the full matrix ---------------------------------------------------------------------------------------------

type Action = "confirm" | "reschedule" | "cancel" | "checkIn" | "complete" | "noShow";
const ACTIONS: Action[] = ["confirm", "reschedule", "cancel", "checkIn", "complete", "noShow"];
const STATUSES = Object.values(BookingStatus);

/** Where each action is allowed from, and where it lands. Written out by hand, then cross-checked against the shared machine. */
const LEGAL: Record<Action, { from: BookingStatus[]; to: BookingStatus }> = {
  confirm: { from: ["HOLD"], to: "CONFIRMED" },
  reschedule: { from: ["CONFIRMED"], to: "CONFIRMED" },
  cancel: { from: ["HOLD", "CONFIRMED"], to: "CANCELLED" },
  checkIn: { from: ["CONFIRMED"], to: "CHECKED_IN" },
  complete: { from: ["CHECKED_IN"], to: "COMPLETED" },
  noShow: { from: ["CONFIRMED"], to: "NO_SHOW" },
};

describe("every transition through the engine", () => {
  test("the hand-written table agrees with the shared machine (per target status, across the actions that reach it)", () => {
    for (const target of STATUSES) {
      const reaching = ACTIONS.filter((a) => LEGAL[a].to === target);
      for (const status of STATUSES) {
        const engineAllows = reaching.some((a) => LEGAL[a].from.includes(status));
        // EXPIRED has no action: only the sweep sets it.
        assert.equal(canTransition(bookingMachine, status, target), engineAllows || (target === "EXPIRED" && status === "HOLD"), `${status} -> ${target}`);
      }
    }
  });

  async function toStatus(s: Salon, status: BookingStatus, minutes: number): Promise<BookingView> {
    const ctx = ctxFor(s.tenantId);
    const afterStart = ctxFor(s.tenantId, { now: atDate(minutes + 5) });
    if (status === "HOLD") return book(env, s, { minutes, confirm: false });
    if (status === "EXPIRED") {
      const h = await book(env, s, { minutes, confirm: false });
      const later = ctxFor(s.tenantId, { now: new Date(Date.parse(h.holdExpiresAt as string) + 1000) });
      await tx(env, later, (c) => expireHolds(c, later));
      return tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: h.id }));
    }
    let b = await book(env, s, { minutes });
    if (status === "CONFIRMED") return b;
    if (status === "CANCELLED") return (await tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: b.id }))).booking;
    if (status === "NO_SHOW") return (await tx(env, afterStart, (c) => markNoShow(c, afterStart, { bookingId: b.id, expectedVersion: b.version }))).booking;
    b = (await tx(env, ctx, (c) => checkIn(c, ctx, { bookingId: b.id, expectedVersion: b.version }))).booking;
    if (status === "CHECKED_IN") return b;
    return (await tx(env, ctx, (c) => complete(c, ctx, { bookingId: b.id, expectedVersion: b.version }))).booking;
  }

  function run(s: Salon, action: Action, b: BookingView, minutes: number) {
    const ctx = action === "noShow" ? ctxFor(s.tenantId, { now: atDate(minutes + 5) }) : ctxFor(s.tenantId);
    const base = { bookingId: b.id };
    switch (action) {
      case "confirm":
        return tx(env, ctx, (c) => confirmBooking(c, ctx, { ...base, customerId: s.customerId, expectedVersion: b.version }));
      case "reschedule":
        return tx(env, ctx, (c) => rescheduleBooking(c, ctx, { ...base, startsAt: at(minutes), resourceId: s.resourceIds[1] as string, expectedVersion: b.version }));
      case "cancel":
        return tx(env, ctx, (c) => cancelBooking(c, ctx, { ...base, expectedVersion: b.version }));
      case "checkIn":
        return tx(env, ctx, (c) => checkIn(c, ctx, { ...base, expectedVersion: b.version }));
      case "complete":
        return tx(env, ctx, (c) => complete(c, ctx, { ...base, expectedVersion: b.version }));
      case "noShow":
        return tx(env, ctx, (c) => markNoShow(c, ctx, { ...base, expectedVersion: b.version }));
    }
  }

  test("each action from each of the seven statuses: legal ones land where the machine says, illegal ones change nothing", async () => {
    const s = await seedSalon(env, { resources: 2 });
    let slot = 0;
    let legalCount = 0;
    let illegalCount = 0;
    for (const status of STATUSES) {
      for (const action of ACTIONS) {
        // One fresh booking per pair, each in its own hour (10 per day, Monday to Saturday).
        const minutes = Math.floor(slot / 10) * 1440 + (slot % 10) * 60;
        slot++;
        const before = await toStatus(s, status, minutes);
        assert.equal(before.status, status, `setup for ${status}`);
        const label = `${action} from ${status}`;
        if (LEGAL[action].from.includes(status)) {
          const res = await run(s, action, before, minutes);
          assert.equal(res.booking.status, LEGAL[action].to, label);
          assert.equal(res.booking.version, before.version + 1, `${label}: version bumps`);
          legalCount++;
        } else {
          const code = action === "confirm" && status === "EXPIRED" ? ErrorCode.HOLD_EXPIRED : ErrorCode.INVALID_TRANSITION;
          await expectAppError(run(s, action, before, minutes), code);
          const ctx = ctxFor(s.tenantId);
          const after = await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: before.id }));
          assert.equal(after.status, before.status, `${label}: status unchanged`);
          assert.equal(after.version, before.version, `${label}: version unchanged`);
          illegalCount++;
        }
      }
    }
    assert.equal(legalCount, 7);
    assert.equal(illegalCount, 35);
  });

  test("the INVALID_TRANSITION error says where the booking is and what is allowed", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const done = await book(env, s);
    const ctx = ctxFor(s.tenantId);
    const cancelled = await tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: done.id }));
    const err = await expectAppError(tx(env, ctx, (c) => checkIn(c, ctx, { bookingId: done.id, expectedVersion: cancelled.booking.version })), ErrorCode.INVALID_TRANSITION);
    assert.equal(err.details.from, "CANCELLED");
    assert.equal(err.details.to, "CHECKED_IN");
    assert.deepEqual(err.details.allowed, []);
  });

  test("transitionBooking is the dashboard dispatcher: only CHECKED_IN, COMPLETED and NO_SHOW", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const ctx = ctxFor(s.tenantId);
    const inn = await tx(env, ctx, (c) => transitionBooking(c, ctx, { bookingId: b.id, to: "CHECKED_IN", expectedVersion: b.version }));
    assert.equal(inn.booking.status, "CHECKED_IN");
    const out = await tx(env, ctx, (c) => transitionBooking(c, ctx, { bookingId: b.id, to: "COMPLETED", expectedVersion: inn.booking.version }));
    assert.equal(out.booking.status, "COMPLETED");
    for (const to of ["CANCELLED", "CONFIRMED", "EXPIRED", "HOLD"]) {
      await expectAppError(tx(env, ctx, (c) => transitionBooking(c, ctx, { bookingId: b.id, to, expectedVersion: out.booking.version })), ErrorCode.VALIDATION_FAILED);
    }
  });

  test("no-show is refused before the booking starts, and frees the slot afterwards", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const early = ctxFor(s.tenantId, { now: atDate(-30) });
    await expectAppError(tx(env, early, (c) => markNoShow(c, early, { bookingId: b.id, expectedVersion: b.version })), ErrorCode.CONFLICT, (e) => assert.equal(e.details.reason, "not_started"));
    const late = ctxFor(s.tenantId, { now: atDate(15) });
    const res = await tx(env, late, (c) => markNoShow(c, late, { bookingId: b.id, expectedVersion: b.version }));
    assert.equal(res.booking.status, "NO_SHOW");
    const again = await book(env, s); // the slot is free
    assert.equal(again.status, "CONFIRMED");
  });
});

describe("optimistic concurrency", () => {
  test("a stale expectedVersion is VERSION_CONFLICT and changes nothing", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const ctx = ctxFor(s.tenantId);
    const moved = await tx(env, ctx, (c) => checkIn(c, ctx, { bookingId: b.id, expectedVersion: b.version }));
    const err = await expectAppError(tx(env, ctx, (c) => complete(c, ctx, { bookingId: b.id, expectedVersion: b.version })), ErrorCode.VERSION_CONFLICT);
    assert.equal(err.details.expectedVersion, b.version);
    assert.equal(err.details.currentVersion, moved.booking.version);
    const now = await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: b.id }));
    assert.equal(now.status, "CHECKED_IN");
    // Cancel and confirm take an optional version; a wrong one is refused too.
    await expectAppError(tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: b.id, expectedVersion: 1 })), ErrorCode.VERSION_CONFLICT);
  });

  test("two staff acting on the same version at once: one wins, one gets VERSION_CONFLICT", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const run = (i: number) => {
      const ctx = ctxFor(s.tenantId, { actorId: `staff-${i}` });
      return tx(env, ctx, (c) => checkIn(c, ctx, { bookingId: b.id, expectedVersion: b.version }));
    };
    const settled = await Promise.allSettled([run(1), run(2), run(3), run(4)]);
    assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of settled) {
      if (r.status === "rejected") assert.equal((r.reason as { code: string }).code, ErrorCode.VERSION_CONFLICT);
    }
    const ctx = ctxFor(s.tenantId);
    assert.equal((await tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: b.id }))).version, b.version + 1);
  });

  test("version is required for reschedule and for the lifecycle actions", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s);
    const ctx = ctxFor(s.tenantId);
    await expectAppError(tx(env, ctx, (c) => checkIn(c, ctx, { bookingId: b.id })), ErrorCode.VALIDATION_FAILED);
    await expectAppError(tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(60) })), ErrorCode.VALIDATION_FAILED);
  });
});

describe("the pack narrows the machine", () => {
  const narrowed = (): ConfigPack => ({
    ...getPack("salon"),
    bookingTransitions: {
      transitions: bookingTransitionsWithout([BookingStatus.CONFIRMED, BookingStatus.NO_SHOW], [BookingStatus.CONFIRMED, BookingStatus.CONFIRMED]),
      labels: {},
    },
  });

  test("an edge the pack removed is INVALID_TRANSITION even though the default machine has it", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const pack = narrowed();
    const b = await book(env, s);
    const late = ctxFor(s.tenantId, { now: atDate(15) });
    await expectAppError(tx(env, late, (c) => markNoShow(c, late, { bookingId: b.id, expectedVersion: b.version }, { pack })), ErrorCode.INVALID_TRANSITION);
    const ctx = ctxFor(s.tenantId);
    await expectAppError(tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(120), expectedVersion: b.version }, { pack })), ErrorCode.INVALID_TRANSITION);
    // Edges the pack kept still work.
    const ok = await tx(env, ctx, (c) => checkIn(c, ctx, { bookingId: b.id, expectedVersion: b.version }, { pack }));
    assert.equal(ok.booking.status, "CHECKED_IN");
  });

  test("a pack with bookings turned off refuses every write", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    const off = getPack("retail");
    assert.equal(off.bookingMode, "none");
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(0), durationMinutes: 30 }, { pack: off })), ErrorCode.TOOL_NOT_ENABLED);
  });

  test("a tenant with no pack is PACK_INVALID", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => c.query("update tenants set pack_id = null, pack_version = null where id = $1", [s.tenantId]));
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(0), durationMinutes: 30 })), ErrorCode.PACK_INVALID);
  });

  test("invalid tenant booking settings are PACK_INVALID, not silently ignored", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => c.query("update tenants set settings = $2::jsonb where id = $1", [s.tenantId, JSON.stringify({ bookings: { holdMinutes: 100000 } })]));
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(0), durationMinutes: 30 })), ErrorCode.PACK_INVALID);
  });

  test("a tenant's own hold length overrides the pack", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => c.query("update tenants set settings = $2::jsonb where id = $1", [s.tenantId, JSON.stringify({ bookings: { holdMinutes: 3 } })]));
    const h = await tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(0), catalogueItemId: s.serviceId }));
    assert.equal(Date.parse(h.booking.holdExpiresAt as string) - ctx.now().getTime(), 3 * 60_000);
  });
});

void insert;
