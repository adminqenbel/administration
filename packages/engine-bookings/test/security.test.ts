// Regression tests for docs/security/REVIEW-stage2.md: SEC-004 (hold limits), SEC-005 (no customer-chosen length),
// SEC-008 (ownership on customer channels), SEC-009 (e-mail oracle on confirm), SEC-010 (idempotency bound to the principal).
// They mirror the PoCs in docs/security/poc/engine-abuse.test.ts, run against the shared test database.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { withTenant } from "@qenbel/db";
import { AppError, ErrorCode, type Channel, type EngineContext } from "@qenbel/shared";
import {
  cancelBooking,
  checkIn,
  confirmBooking,
  createHold,
  expireHolds,
  getBooking,
  listBookingEvents,
  listBookings,
  rescheduleBooking,
} from "../src/index.ts";
import { at, atDate, book, connect, ctxFor, expectAppError, insert, rowsOf, seedSalon, tx, type Env, type Salon } from "./helpers.ts";

let env: Env;
before(async () => {
  env = await connect({ max: 30 });
});
after(async () => {
  await env.close();
});

const DAY = 24 * 60;

async function conversation(s: Salon, channel: Channel = "web_chat"): Promise<string> {
  return tx(env, ctxFor(s.tenantId), (c) => insert(c, "conversations", { tenant_id: s.tenantId, channel }));
}

/** A customer-channel context: what the channel layer builds for a widget visitor, a WhatsApp sender or a caller. */
function chan(
  s: Salon,
  o: { channel?: Channel; customerId?: string; conversationId?: string; actorId?: string; key?: string; now?: Date } = {},
): EngineContext {
  const subject: { customerId?: string; conversationId?: string } = {};
  if (o.customerId !== undefined) subject.customerId = o.customerId;
  if (o.conversationId !== undefined) subject.conversationId = o.conversationId;
  return ctxFor(s.tenantId, {
    channel: o.channel ?? "web_chat",
    kind: "api_credential",
    actorId: o.actorId ?? "cred-widget",
    ...(o.key !== undefined ? { key: o.key } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
    ...(o.customerId !== undefined || o.conversationId !== undefined ? { subject } : {}),
  });
}

const holdAt = (s: Salon, minutes: number, extra: Record<string, unknown> = {}) => ({
  startsAt: at(minutes),
  catalogueItemId: s.serviceId,
  ...extra,
});

async function setLimits(s: Salon, limits: Record<string, number>): Promise<void> {
  await tx(env, ctxFor(s.tenantId), (c) =>
    c.query("update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{bookings}', $2::jsonb) where id = $1", [
      s.tenantId,
      JSON.stringify({ limits }),
    ]),
  );
}

async function anotherCustomer(s: Salon, name = "Bob Other"): Promise<string> {
  return tx(env, ctxFor(s.tenantId), (c) =>
    insert(c, "customers", { tenant_id: s.tenantId, name, phone: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}` }),
  );
}

function errorBody(e: AppError): unknown {
  return { code: e.code, message: e.message, details: e.details };
}

async function caught(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AppError, `expected AppError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected the call to fail");
}

describe("SEC-004 hold limits on customer channels", () => {
  test("PoC: 30 sequential holds from one anonymous web-chat conversation: only 2 are accepted", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const conv = await conversation(s);
    let accepted = 0;
    for (let i = 0; i < 30; i++) {
      const ctx = chan(s, { conversationId: conv, key: `hoard-${i}-${s.tenantId.slice(0, 8)}` });
      try {
        await tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, Math.floor(i / 10) * DAY + (i % 10) * 60, { resourceId: s.resourceIds[0] })));
        accepted++;
      } catch (e) {
        assert.ok(e instanceof AppError && e.code === ErrorCode.RATE_LIMITED, String(e));
        assert.deepEqual(e.details, { reason: "hold_limit", scope: "conversation" });
      }
    }
    assert.equal(accepted, 2);
  });

  test("20 parallel holds from one anonymous conversation on different slots: at most the limit gets through", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const conv = await conversation(s);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => {
        const ctx = chan(s, { conversationId: conv });
        return tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, (i % 9) * 60, { resourceId: s.resourceIds[i % 2] })));
      }),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(ok, 2, `${ok} holds accepted`);
    for (const r of results) {
      if (r.status === "rejected") {
        const code = (r.reason as AppError).code;
        assert.ok(code === ErrorCode.RATE_LIMITED || code === ErrorCode.BOOKING_SLOT_TAKEN, `unexpected ${code}`);
      }
    }
    const [n] = await rowsOf<{ n: string }>(env, s.tenantId, "select count(*) n from bookings where conversation_id = $1 and status = 'HOLD'", [conv]);
    assert.equal(n?.n, "2");
  });

  test("a verified customer may hold 5 at once, across conversations", async () => {
    const s = await seedSalon(env, { resources: 1 });
    let accepted = 0;
    for (let i = 0; i < 7; i++) {
      const ctx = chan(s, { channel: "whatsapp", customerId: s.customerId, conversationId: await conversation(s, "whatsapp") });
      try {
        await tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, i * 60, { resourceId: s.resourceIds[0] })));
        accepted++;
      } catch (e) {
        assert.equal((e as AppError).details.scope, "customer");
      }
    }
    assert.equal(accepted, 5);
  });

  test("per-credential and per-tenant ceilings are tenant settings; the dashboard is never limited", async () => {
    const s = await seedSalon(env, { resources: 2 });
    await setLimits(s, { holdsPerCredential: 3, holdsPerTenant: 4 });
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const ctx = chan(s, { conversationId: await conversation(s), actorId: "cred-a" });
      outcomes.push(
        await tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, i * 60, { resourceId: s.resourceIds[0] }))).then(
          () => "ok",
          (e: AppError) => String(e.details.scope),
        ),
      );
    }
    assert.deepEqual(outcomes, ["ok", "ok", "ok", "credential"]);
    const other = chan(s, { conversationId: await conversation(s), actorId: "cred-b" });
    await tx(env, other, (c) => createHold(c, other, holdAt(s, 0, { resourceId: s.resourceIds[1] })));
    const late = chan(s, { conversationId: await conversation(s), actorId: "cred-c" });
    const e = await caught(tx(env, late, (c) => createHold(c, late, holdAt(s, 120, { resourceId: s.resourceIds[1] }))));
    assert.deepEqual([e.code, e.details.scope], [ErrorCode.RATE_LIMITED, "tenant"]);
    const staff = ctxFor(s.tenantId);
    for (let i = 0; i < 5; i++) await tx(env, staff, (c) => createHold(c, staff, holdAt(s, DAY + i * 60, { resourceId: s.resourceIds[1] })));
  });

  test("expired holds do not count, and an unverified hold lives at most 10 minutes", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const conv = await conversation(s);
    const now = new Date(Date.parse(at(-DAY)));
    const ctx = chan(s, { conversationId: conv, now });
    const first = await tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, 0)));
    await tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, 60)));
    assert.equal(Date.parse(first.booking.holdExpiresAt as string) - now.getTime(), 10 * 60_000);
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, 120))), ErrorCode.RATE_LIMITED);
    const later = chan(s, { conversationId: conv, now: new Date(now.getTime() + 11 * 60_000) });
    await tx(env, later, (c) => createHold(c, later, holdAt(s, 120)));
  });

  test("active bookings per conversation are capped, so hold-confirm loops with made-up customers stop", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await setLimits(s, { activeBookingsPerConversation: 2 });
    const conv = await conversation(s);
    const ctx = chan(s, { conversationId: conv });
    for (let i = 0; i < 2; i++) {
      const h = await tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, i * 60)));
      await tx(env, ctx, (c) =>
        confirmBooking(c, ctx, { bookingId: h.booking.id, customer: { name: `Fake ${i}`, phone: `98765${String(43210 + i)}` } }),
      );
    }
    const e = await caught(tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, 180))));
    assert.deepEqual([e.code, e.details.reason, e.details.scope], [ErrorCode.RATE_LIMITED, "booking_limit", "conversation"]);
  });

  test("a verified customer at the active-bookings limit cannot hold or confirm more", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await setLimits(s, { activeBookingsPerCustomer: 1 });
    await book(env, s, { minutes: 0 });
    const ctx = chan(s, { channel: "whatsapp", customerId: s.customerId });
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, 120))), ErrorCode.RATE_LIMITED);
    // A hold made by staff for this customer cannot be confirmed over the limit from the customer channel either.
    const staff = ctxFor(s.tenantId);
    const h = await tx(env, staff, (c) => createHold(c, staff, holdAt(s, 240, { customerId: s.customerId })));
    await expectAppError(tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: h.booking.id, customerId: s.customerId })), ErrorCode.RATE_LIMITED);
    await tx(env, staff, (c) => confirmBooking(c, staff, { bookingId: h.booking.id, customerId: s.customerId }));
  });
});

describe("SEC-005 the length comes from the service on customer channels", () => {
  test("PoC: durationMinutes 600 or a free endsAt is refused; without a service there is no hold; the service gives 60 minutes", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = chan(s, { conversationId: await conversation(s) });
    const r = s.resourceIds[0] as string;
    for (const body of [{ startsAt: at(0), durationMinutes: 600, resourceId: r }, { startsAt: at(0), endsAt: at(600), catalogueItemId: s.serviceId, resourceId: r }]) {
      await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, body)), ErrorCode.VALIDATION_FAILED, (e) => assert.equal(e.details.reason, "duration_not_allowed"));
    }
    await expectAppError(tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(0), resourceId: r, durationMinutes: 60 })), ErrorCode.VALIDATION_FAILED);
    const h = await tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, 0, { resourceId: r })));
    assert.equal((Date.parse(h.booking.endsAt) - Date.parse(h.booking.startsAt)) / 60_000, 60);
    // Staff on the dashboard may still choose a length.
    const staff = ctxFor(s.tenantId);
    const long = await tx(env, staff, (c) => createHold(c, staff, { startsAt: at(120), durationMinutes: 300, resourceId: r }));
    assert.equal(long.booking.endsAt, at(420));
  });

  test("a reschedule from a customer channel keeps the length; more than 3 resources in one hold is refused", async () => {
    const s = await seedSalon(env, { resources: 4 });
    const b = await book(env, s, { minutes: 0 });
    const ctx = chan(s, { channel: "whatsapp", customerId: s.customerId });
    await expectAppError(
      tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(120), durationMinutes: 480, expectedVersion: b.version })),
      ErrorCode.VALIDATION_FAILED,
      (e) => assert.equal(e.details.reason, "duration_not_allowed"),
    );
    const moved = await tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(120), expectedVersion: b.version }));
    assert.equal(moved.booking.endsAt, at(180));
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, 300, { resourceIds: s.resourceIds }))),
      ErrorCode.VALIDATION_FAILED,
      (e) => assert.equal(e.details.reason, "too_many_resources"),
    );
  });
});

describe("SEC-008 ownership on customer channels", () => {
  test("PoC: someone else's confirmed booking cannot be cancelled, moved, confirmed or read; the answer equals an unknown id", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const alice = await book(env, s, { minutes: 5 * DAY });
    const bob = await anotherCustomer(s);
    const unknown = "00000000-0000-4000-8000-00000000beef";
    for (const ctx of [chan(s, { channel: "whatsapp" }), chan(s, { channel: "whatsapp", customerId: bob }), chan(s, { channel: "voice", conversationId: await conversation(s, "voice") })]) {
      const calls = (id: string) => [
        () => tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: id, reason: "not me" })),
        () => tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: id, startsAt: at(5 * DAY + 120), expectedVersion: alice.version })),
        () => tx(env, ctx, (c) => confirmBooking(c, ctx, { bookingId: id, customerId: s.customerId })),
        () => tx(env, ctx, (c) => getBooking(c, ctx, { bookingId: id })),
        () => tx(env, ctx, (c) => listBookingEvents(c, ctx, { bookingId: id })),
      ];
      const foreign = calls(alice.id);
      const absent = calls(unknown);
      for (let i = 0; i < foreign.length; i++) {
        const a = await caught((foreign[i] as () => Promise<unknown>)());
        const b = await caught((absent[i] as () => Promise<unknown>)());
        assert.equal(a.code, ErrorCode.NOT_FOUND);
        assert.deepEqual(errorBody(a), errorBody(b), `call ${i}: a foreign booking must look exactly like a missing one`);
      }
      const page = await tx(env, ctx, (c) => listBookings(c, ctx, { customerId: s.customerId }));
      assert.deepEqual(page.items, []);
    }
    const staff = ctxFor(s.tenantId);
    assert.equal((await tx(env, staff, (c) => getBooking(c, staff, { bookingId: alice.id }))).status, "CONFIRMED");
    // Alice herself, verified by the channel layer, can.
    const mine = chan(s, { channel: "whatsapp", customerId: s.customerId });
    assert.equal((await tx(env, mine, (c) => getBooking(c, mine, { bookingId: alice.id }))).id, alice.id);
    assert.deepEqual((await tx(env, mine, (c) => listBookings(c, mine, {}))).items.map((b) => b.id), [alice.id]);
    assert.equal((await tx(env, mine, (c) => cancelBooking(c, mine, { bookingId: alice.id }))).booking.status, "CANCELLED");
  });

  test("an anonymous widget hold can be confirmed and cancelled only from its own conversation", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const mineConv = await conversation(s);
    const mine = chan(s, { conversationId: mineConv });
    const other = chan(s, { conversationId: await conversation(s) });
    const h = await tx(env, mine, (c) => createHold(c, mine, holdAt(s, 0)));
    const [row] = await rowsOf<{ conversation_id: string; customer_id: string | null }>(env, s.tenantId, "select conversation_id, customer_id from bookings where id = $1", [h.booking.id]);
    assert.deepEqual([row?.conversation_id, row?.customer_id], [mineConv, null]);

    const details = { customer: { name: "Mallory", phone: "9876500001" } };
    await expectAppError(tx(env, other, (c) => confirmBooking(c, other, { bookingId: h.booking.id, ...details })), ErrorCode.NOT_FOUND);
    await expectAppError(tx(env, other, (c) => cancelBooking(c, other, { bookingId: h.booking.id })), ErrorCode.NOT_FOUND);
    const done = await tx(env, mine, (c) => confirmBooking(c, mine, { bookingId: h.booking.id, customer: { name: "Carol", phone: "9876500002" } }));
    assert.equal(done.booking.status, "CONFIRMED");
    await expectAppError(tx(env, other, (c) => cancelBooking(c, other, { bookingId: h.booking.id })), ErrorCode.NOT_FOUND);
    assert.equal((await tx(env, mine, (c) => cancelBooking(c, mine, { bookingId: h.booking.id }))).booking.status, "CANCELLED");
  });

  test("holds need a subject; a customer channel cannot attach another customer's id or an unknown conversation", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const bob = await anotherCustomer(s);
    const none = chan(s);
    await expectAppError(tx(env, none, (c) => createHold(c, none, holdAt(s, 0))), ErrorCode.FORBIDDEN, (e) => assert.equal(e.details.reason, "subject_required"));
    const asBob = chan(s, { channel: "whatsapp", customerId: bob });
    await expectAppError(tx(env, asBob, (c) => createHold(c, asBob, holdAt(s, 0, { customerId: s.customerId }))), ErrorCode.NOT_FOUND);
    const anon = chan(s, { conversationId: await conversation(s) });
    await expectAppError(tx(env, anon, (c) => createHold(c, anon, holdAt(s, 0, { customerId: s.customerId }))), ErrorCode.NOT_FOUND);
    const ghost = chan(s, { conversationId: "00000000-0000-4000-8000-0000000c0de0" });
    await expectAppError(tx(env, ghost, (c) => createHold(c, ghost, holdAt(s, 0))), ErrorCode.NOT_FOUND);
    // A verified customer's hold belongs to them; confirming it for someone else is refused.
    const h = await tx(env, asBob, (c) => createHold(c, asBob, holdAt(s, 0)));
    assert.equal(h.booking.customerId, bob);
    await expectAppError(tx(env, asBob, (c) => confirmBooking(c, asBob, { bookingId: h.booking.id, customerId: s.customerId })), ErrorCode.NOT_FOUND);
    assert.equal((await tx(env, asBob, (c) => confirmBooking(c, asBob, { bookingId: h.booking.id, customerId: bob }))).booking.customerId, bob);
  });

  test("staff-only operations are refused on customer channels", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s, { minutes: 0 });
    const mine = chan(s, { channel: "whatsapp", customerId: s.customerId });
    await expectAppError(tx(env, mine, (c) => checkIn(c, mine, { bookingId: b.id, expectedVersion: b.version })), ErrorCode.FORBIDDEN);
    await expectAppError(tx(env, mine, (c) => expireHolds(c, mine)), ErrorCode.FORBIDDEN);
  });

  test("a foreign id never waits on a row lock (no lock contention through guessed ids)", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const b = await book(env, s, { minutes: 0 });
    const bob = await anotherCustomer(s);
    const ctx = chan(s, { channel: "whatsapp", customerId: bob });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = withTenant(env.app, s.tenantId, async (c) => {
      await c.query("select id from bookings where id = $1 for update", [b.id]);
      locked();
      await held;
    });
    await isLocked;
    const started = Date.now();
    await expectAppError(tx(env, ctx, (c) => cancelBooking(c, ctx, { bookingId: b.id })), ErrorCode.NOT_FOUND);
    assert.ok(Date.now() - started < 2000, "answered without waiting for the lock");
    release();
    await holder;
  });
});

describe("SEC-009 and SEC-010", () => {
  test("a customer-channel confirm with someone else's e-mail succeeds without revealing or using that customer", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await tx(env, ctxFor(s.tenantId), (c) => c.query("update customers set email = 'alice@example.com' where id = $1", [s.customerId]));
    const ctx = chan(s, { conversationId: await conversation(s) });
    const h = await tx(env, ctx, (c) => createHold(c, ctx, holdAt(s, 0)));
    const done = await tx(env, ctx, (c) =>
      confirmBooking(c, ctx, { bookingId: h.booking.id, customer: { name: "Mallory", phone: "9876599999", email: "Alice@example.com" } }),
    );
    assert.notEqual(done.booking.customerId, s.customerId);
    const [created] = await rowsOf<{ email: string | null }>(env, s.tenantId, "select email from customers where id = $1", [done.booking.customerId]);
    assert.equal(created?.email, null, "the taken e-mail is not stored on the new record");
    // On the dashboard the same e-mail matches the existing customer.
    const staff = ctxFor(s.tenantId);
    const h2 = await tx(env, staff, (c) => createHold(c, staff, holdAt(s, 120)));
    const d2 = await tx(env, staff, (c) => confirmBooking(c, staff, { bookingId: h2.booking.id, customer: { name: "Alice", phone: "9876588888", email: "alice@example.com" } }));
    assert.equal(d2.booking.customerId, s.customerId);
  });

  test("PoC: another credential repeating a key and body is not handed the first result, and learns nothing from a different body", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const key = `voice-call-4711-hold-1-${s.tenantId.slice(0, 6)}`;
    const voice = ctxFor(s.tenantId, { kind: "api_credential", actorId: "cred-voice", channel: "api", key });
    const widget = ctxFor(s.tenantId, { kind: "api_credential", actorId: "cred-widget", channel: "api", key });
    const body = holdAt(s, 7 * DAY, { resourceId: s.resourceIds[0] });
    const first = await tx(env, voice, (c) => createHold(c, voice, body));
    // Same body: not a replay; the slot really is taken.
    await expectAppError(tx(env, widget, (c) => createHold(c, widget, body)), ErrorCode.BOOKING_SLOT_TAKEN);
    // Different body: no IDEMPOTENCY_CONFLICT (which would reveal that the key exists); it simply runs.
    const second = await tx(env, widget, (c) => createHold(c, widget, holdAt(s, 7 * DAY + 120, { resourceId: s.resourceIds[0] })));
    assert.notEqual(second.booking.id, first.booking.id);
    assert.equal(second.replayed, false);
    // The original principal still replays its own result.
    const again = await tx(env, voice, (c) => createHold(c, voice, body));
    assert.deepEqual([again.replayed, again.booking.id], [true, first.booking.id]);
    void atDate;
  });
});
