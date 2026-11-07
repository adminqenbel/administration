import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrincipalKind } from "@qenbel/shared";
import {
  addCustomerNote, createCatalogueItem, createCustomer, createFollowUp, getCustomerBalance, getCustomerTimeline, getFollowUp,
  listCommunications, listCustomerNotes, listFollowUps, logCommunication, setFollowUpStatus, updateFollowUp,
} from "../src/index.ts";
import { NOW, at, call, connectTestDb, insertBooking, insertOrder, insertPayment, makeCtx, rejectsWith, tx, type TestDb } from "./helpers.ts";

let db: TestDb;
before(async () => {
  db = await connectTestDb();
});
after(async () => {
  await db.close();
});

async function newCustomer(t: string, name = "Cust", phone?: string) {
  return (await call(db, makeCtx(t), createCustomer, { name, ...(phone ? { phone } : {}) })).customer;
}

async function newUser(t: string): Promise<string> {
  return tx(db, t, async (c) => {
    const r = await c.query<{ id: string }>(
      "insert into users (tenant_id, auth_provider, external_subject, name, role) values ($1, 'dev', $2, 'Staff Person', 'STAFF') returning id",
      [t, `dev|${randomUUID()}`],
    );
    return (r.rows[0] as { id: string }).id;
  });
}

const ghost = "11111111-1111-1111-1111-111111111111";

describe("notes", () => {
  test("add and list newest first; author is recorded only for a real user of this tenant", async () => {
    const t = await db.createTenant("crm-notes");
    const user = await newUser(t);
    const c = await newCustomer(t);
    const byUser = await call(db, makeCtx(t, { kind: PrincipalKind.USER, actorId: user }), addCustomerNote, { customerId: c.id, body: "Called, wants Friday" });
    assert.equal(byUser.authorUserId, user);
    const byApi = await call(db, makeCtx(t, { kind: PrincipalKind.API_CREDENTIAL, actorId: randomUUID() }), addCustomerNote, { customerId: c.id, body: "From the assistant" });
    assert.equal(byApi.authorUserId, null);
    const phantom = await call(db, makeCtx(t, { kind: PrincipalKind.USER, actorId: randomUUID() }), addCustomerNote, { customerId: c.id, body: "Unknown user id" });
    assert.equal(phantom.authorUserId, null);

    for (let i = 0; i < 4; i++) await call(db, makeCtx(t), addCustomerNote, { customerId: c.id, body: `bulk ${i}` });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(db, makeCtx(t), listCustomerNotes, { customerId: c.id, limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((n) => n.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7);
  });

  test("unknown customer, empty body and smuggled keys are refused", async () => {
    const t = await db.createTenant("crm-notes-bad");
    const c = await newCustomer(t);
    const ctx = makeCtx(t);
    await rejectsWith(call(db, ctx, addCustomerNote, { customerId: ghost, body: "x" }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, addCustomerNote, { customerId: c.id, body: "   " }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, addCustomerNote, { customerId: c.id, body: "x", tenantId: t } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, addCustomerNote, { customerId: c.id, body: "x".repeat(4001) }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, addCustomerNote, { customerId: c.id, body: "bell\u0007" }), "VALIDATION_FAILED");
  });
});

describe("follow-up tasks", () => {
  test("origin defaults from the actor and an explicit origin is honoured", async () => {
    const t = await db.createTenant("crm-fu-origin");
    const c = await newCustomer(t);
    const mk = (kind: PrincipalKind, extra: Record<string, unknown> = {}) =>
      call(db, makeCtx(t, { kind }), createFollowUp, { title: "Call back", customerId: c.id, ...extra });
    assert.equal((await mk(PrincipalKind.USER)).origin, "staff");
    assert.equal((await mk(PrincipalKind.API_CREDENTIAL)).origin, "ai_escalation");
    assert.equal((await mk(PrincipalKind.SYSTEM)).origin, "system");
    assert.equal((await mk(PrincipalKind.SYSTEM, { origin: "ai_escalation" })).origin, "ai_escalation");
    await rejectsWith(mk(PrincipalKind.USER, { origin: "robot" }), "VALIDATION_FAILED");
  });

  test("references must exist in this tenant", async () => {
    const ta = await db.createTenant("crm-fu-ref-a");
    const tb = await db.createTenant("crm-fu-ref-b");
    const ca = await newCustomer(ta);
    const cb = await newCustomer(tb);
    const bookingB = await tx(db, tb, (c) => insertBooking(c, tb, { customerId: cb.id, from: at(600), to: at(660) }));
    const userB = await newUser(tb);
    const ctx = makeCtx(ta);
    const e1 = await rejectsWith(call(db, ctx, createFollowUp, { title: "x", customerId: cb.id }), "NOT_FOUND");
    assert.equal(e1.details.field, "customerId");
    const e2 = await rejectsWith(call(db, ctx, createFollowUp, { title: "x", customerId: ca.id, bookingId: bookingB }), "NOT_FOUND");
    assert.equal(e2.details.field, "bookingId");
    const e3 = await rejectsWith(call(db, ctx, createFollowUp, { title: "x", assignedUserId: userB }), "NOT_FOUND");
    assert.equal(e3.details.field, "assignedUserId");
    await rejectsWith(call(db, ctx, createFollowUp, { title: "x", orderId: ghost }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, createFollowUp, { title: "x", conversationId: ghost }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, createFollowUp, { title: "x", tenantId: tb } as never), "VALIDATION_FAILED");
  });

  test("status moves: open to done sets completedAt, done to cancelled is refused, reopen clears it", async () => {
    const t = await db.createTenant("crm-fu-status");
    const ctx = makeCtx(t);
    const f = await call(db, ctx, createFollowUp, { title: "Chase payment", dueAt: "2031-01-10T09:00:00+05:30" });
    assert.equal(f.status, "open");
    assert.equal(f.dueAt, "2031-01-10T03:30:00.000Z");
    const done = await call(db, ctx, setFollowUpStatus, { followUpId: f.id, status: "done" });
    assert.equal(done.status, "done");
    assert.equal(done.completedAt, NOW.toISOString());
    assert.equal((await call(db, ctx, setFollowUpStatus, { followUpId: f.id, status: "done" })).status, "done", "same status is a no-op");
    await rejectsWith(call(db, ctx, setFollowUpStatus, { followUpId: f.id, status: "cancelled" }), "INVALID_TRANSITION");
    const reopened = await call(db, ctx, setFollowUpStatus, { followUpId: f.id, status: "open" });
    assert.equal(reopened.completedAt, null);
    const cancelled = await call(db, ctx, setFollowUpStatus, { followUpId: f.id, status: "cancelled" });
    assert.equal(cancelled.status, "cancelled");
    await rejectsWith(call(db, ctx, setFollowUpStatus, { followUpId: f.id, status: "weird" }), "VALIDATION_FAILED");
  });

  test("update changes fields and can clear optional ones", async () => {
    const t = await db.createTenant("crm-fu-update");
    const ctx = makeCtx(t);
    const user = await newUser(t);
    const f = await call(db, ctx, createFollowUp, { title: "A", details: "d", dueAt: "2031-02-01T00:00:00Z" });
    const u = await call(db, ctx, updateFollowUp, { followUpId: f.id, title: "B", details: null, dueAt: null, assignedUserId: user });
    assert.equal(u.title, "B");
    assert.equal(u.details, null);
    assert.equal(u.dueAt, null);
    assert.equal(u.assignedUserId, user);
    await rejectsWith(call(db, ctx, updateFollowUp, { followUpId: f.id }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, updateFollowUp, { followUpId: ghost, title: "x" }), "NOT_FOUND");
  });

  test("list filters, newest first, pages without gaps or repeats", async () => {
    const t = await db.createTenant("crm-fu-list");
    const ctx = makeCtx(t);
    const c1 = await newCustomer(t, "One");
    const c2 = await newCustomer(t, "Two");
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push((await call(db, ctx, createFollowUp, { title: `T${i}`, customerId: i < 5 ? c1.id : c2.id, origin: i % 2 ? "staff" : "system", dueAt: `2031-01-${10 + i}T00:00:00Z` })).id);
    }
    await call(db, ctx, setFollowUpStatus, { followUpId: ids[0] as string, status: "done" });
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await call(db, ctx, listFollowUps, { limit: 3, ...(cursor ? { cursor } : {}) });
      all.push(...p.items.map((i) => i.id));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(all.length, 7);
    assert.equal(new Set(all).size, 7);
    assert.equal((await call(db, ctx, listFollowUps, { status: "open" })).items.length, 6);
    assert.equal((await call(db, ctx, listFollowUps, { status: "done" })).items.length, 1);
    assert.equal((await call(db, ctx, listFollowUps, { customerId: c2.id })).items.length, 2);
    assert.equal((await call(db, ctx, listFollowUps, { origin: "staff" })).items.length, 3);
    assert.equal((await call(db, ctx, listFollowUps, { dueBefore: "2031-01-12T00:00:00Z" })).items.length, 3);
  });

  test("tenant A cannot read or change tenant B's tasks", async () => {
    const ta = await db.createTenant("crm-fu-iso-a");
    const tb = await db.createTenant("crm-fu-iso-b");
    const fb = await call(db, makeCtx(tb), createFollowUp, { title: "B only" });
    const ctx = makeCtx(ta);
    await rejectsWith(call(db, ctx, getFollowUp, { followUpId: fb.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, updateFollowUp, { followUpId: fb.id, title: "pwned" }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, setFollowUpStatus, { followUpId: fb.id, status: "done" }), "NOT_FOUND");
    assert.equal((await call(db, ctx, listFollowUps, {})).items.length, 0);
    const still = await call(db, makeCtx(tb), getFollowUp, { followUpId: fb.id });
    assert.equal(still.title, "B only");
    assert.equal(still.status, "open");
  });
});

describe("communications log", () => {
  test("log and list newest first by occurredAt; needs a subject or body", async () => {
    const t = await db.createTenant("crm-comm");
    const ctx = makeCtx(t);
    const c = await newCustomer(t);
    const stamps = ["2031-01-02T10:00:00Z", "2031-01-04T10:00:00Z", "2031-01-03T10:00:00Z", "2031-01-05T10:00:00Z", "2031-01-01T10:00:00Z"];
    for (const [i, occurredAt] of stamps.entries()) {
      await call(db, ctx, logCommunication, { customerId: c.id, direction: i % 2 ? "inbound" : "outbound", channel: i % 2 ? "whatsapp" : "email", body: `m${i}`, occurredAt });
    }
    const got: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await call(db, ctx, listCommunications, { customerId: c.id, limit: 2, ...(cursor ? { cursor } : {}) });
      got.push(...p.items.map((m) => m.occurredAt));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(got, [...stamps].map((s) => new Date(s).toISOString()).sort().reverse());
    await rejectsWith(call(db, ctx, logCommunication, { customerId: c.id, direction: "inbound", channel: "sms" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, logCommunication, { customerId: c.id, direction: "sideways", channel: "sms", body: "x" } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, logCommunication, { customerId: c.id, direction: "inbound", channel: "pigeon", body: "x" } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, logCommunication, { customerId: ghost, direction: "inbound", channel: "sms", body: "x" }), "NOT_FOUND");
  });

  test("cannot link another tenant's booking, and cannot read another tenant's log", async () => {
    const ta = await db.createTenant("crm-comm-a");
    const tb = await db.createTenant("crm-comm-b");
    const ca = await newCustomer(ta);
    const cb = await newCustomer(tb);
    const bookingB = await tx(db, tb, (c) => insertBooking(c, tb, { customerId: cb.id, from: at(600), to: at(660) }));
    await call(db, makeCtx(tb), logCommunication, { customerId: cb.id, direction: "inbound", channel: "voice", body: "secret call notes" });
    const ctxA = makeCtx(ta);
    await rejectsWith(call(db, ctxA, logCommunication, { customerId: ca.id, direction: "inbound", channel: "voice", body: "x", bookingId: bookingB }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, listCommunications, { customerId: cb.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, logCommunication, { customerId: cb.id, direction: "inbound", channel: "voice", body: "x" }), "NOT_FOUND");
  });
});

describe("customer timeline", () => {
  test("bookings, orders, communications, notes and follow-ups, newest first, each once across pages", async () => {
    const t = await db.createTenant("crm-timeline");
    const ctx = makeCtx(t);
    const c = await newCustomer(t, "Timeline", "9000000101");
    const other = await newCustomer(t, "Someone else", "9000000102");
    const item = await call(db, ctx, createCatalogueItem, { kind: "service", name: "Haircut", amountPaise: 50000, durationMinutes: 30 });
    const secretBody = "SECRET-COMM-BODY";
    const longNote = "N".repeat(300);
    await tx(db, t, async (cl) => {
      await insertBooking(cl, t, { customerId: c.id, itemId: item.id, from: at(600), to: at(630) });
      await insertBooking(cl, t, { customerId: c.id, from: at(1000), to: at(1030), status: "CANCELLED" });
      await insertOrder(cl, t, { customerId: c.id, totalPaise: 12345, createdAt: new Date("2031-01-03T00:00:00Z") });
      await insertOrder(cl, t, { customerId: other.id, totalPaise: 987654 });
      await insertBooking(cl, t, { customerId: other.id, from: at(700), to: at(730) });
    });
    await call(db, ctx, logCommunication, { customerId: c.id, direction: "outbound", channel: "email", subject: "Reminder", body: secretBody, occurredAt: "2031-01-02T00:00:00Z" });
    await call(db, ctx, addCustomerNote, { customerId: c.id, body: longNote });
    await call(db, ctx, createFollowUp, { title: "Ring them", customerId: c.id });

    const everything: Array<{ kind: string; id: string; at: string; summary: string; amountPaise: number | null; reference: string | null }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = await call(db, ctx, getCustomerTimeline, { customerId: c.id, limit: 2, ...(cursor ? { cursor } : {}) });
      everything.push(...p.items);
      cursor = p.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    assert.equal(everything.length, 6);
    assert.equal(pages, 3);
    assert.equal(new Set(everything.map((e) => e.id)).size, 6);
    const times = everything.map((e) => e.at);
    assert.deepEqual(times, [...times].sort().reverse(), "newest first");
    assert.deepEqual(everything.map((e) => e.kind).sort(), ["booking", "booking", "communication", "follow_up", "note", "order"]);

    const booking = everything.find((e) => e.kind === "booking" && e.summary === "Haircut");
    assert.ok(booking, "booking summary uses the service name");
    const order = everything.find((e) => e.kind === "order")!;
    assert.equal(order.amountPaise, 12345);
    assert.match(order.summary, /^Order /);
    const wire = JSON.stringify(everything);
    assert.ok(!wire.includes(secretBody), "communication bodies are not in the timeline");
    assert.ok(!wire.includes(longNote), "note text is cut short");
    assert.ok(everything.every((e) => e.amountPaise !== 987654), "other customers rows are not included");

    const onlyOrders = await call(db, ctx, getCustomerTimeline, { customerId: c.id, kinds: ["order", "booking"] });
    assert.deepEqual(onlyOrders.items.map((e) => e.kind).sort(), ["booking", "booking", "order"]);
    await rejectsWith(call(db, ctx, getCustomerTimeline, { customerId: c.id, kinds: ["payments"] } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, getCustomerTimeline, { customerId: c.id, kinds: [] }), "VALIDATION_FAILED");
  });

  test("another tenant's customer id is NOT_FOUND and its rows never appear", async () => {
    const ta = await db.createTenant("crm-tl-a");
    const tb = await db.createTenant("crm-tl-b");
    const cb = await newCustomer(tb, "B Person");
    await tx(db, tb, (cl) => insertOrder(cl, tb, { customerId: cb.id, totalPaise: 777 }));
    await rejectsWith(call(db, makeCtx(ta), getCustomerTimeline, { customerId: cb.id }), "NOT_FOUND");
    await rejectsWith(call(db, makeCtx(ta), getCustomerBalance, { customerId: cb.id }), "NOT_FOUND");
    // B's own view still has it
    assert.equal((await call(db, makeCtx(tb), getCustomerTimeline, { customerId: cb.id })).items.length, 1);
  });
});

describe("outstanding balance", () => {
  test("per order: unpaid part of placed orders, overpayment on one does not offset another, refunds add back", async () => {
    const t = await db.createTenant("crm-balance");
    const ctx = makeCtx(t);
    const c = await newCustomer(t, "Owes", "9000000201");
    await tx(db, t, async (cl) => {
      const o1 = await insertOrder(cl, t, { customerId: c.id, totalPaise: 10000, status: "PLACED" });
      await insertPayment(cl, t, { orderId: o1, customerId: c.id, amountPaise: 4000 });
      await insertPayment(cl, t, { orderId: o1, customerId: c.id, amountPaise: 3000, status: "pending" });
      await insertPayment(cl, t, { orderId: o1, customerId: c.id, amountPaise: 999, status: "failed" });
      const o2 = await insertOrder(cl, t, { customerId: c.id, totalPaise: 5000, status: "FULFILLED" });
      await insertPayment(cl, t, { orderId: o2, customerId: c.id, amountPaise: 7000 });
      const o3 = await insertOrder(cl, t, { customerId: c.id, totalPaise: 8000, status: "READY" });
      await insertPayment(cl, t, { orderId: o3, customerId: c.id, amountPaise: 8000 });
      await insertPayment(cl, t, { orderId: o3, customerId: c.id, amountPaise: 1500, kind: "refund" });
      await insertOrder(cl, t, { customerId: c.id, totalPaise: 90000, status: "DRAFT" });
      await insertOrder(cl, t, { customerId: c.id, totalPaise: 80000, status: "CANCELLED" });
      await insertOrder(cl, t, { customerId: c.id, totalPaise: 70000, status: "REJECTED" });
    });
    const b = await call(db, ctx, getCustomerBalance, { customerId: c.id });
    assert.deepEqual(b.balances, [{ currency: "INR", ordersOutstandingPaise: 6000 + 0 + 1500, depositsOutstandingPaise: 0, totalOutstandingPaise: 7500 }]);
  });

  test("booking deposits count, using payments recorded against the booking", async () => {
    const t = await db.createTenant("crm-balance-dep");
    const ctx = makeCtx(t);
    const c = await newCustomer(t, "Deposit", "9000000202");
    await tx(db, t, async (cl) => {
      const b1 = await insertBooking(cl, t, { customerId: c.id, from: at(600), to: at(660), depositPaise: 2000 });
      await insertPayment(cl, t, { bookingId: b1, customerId: c.id, amountPaise: 500 });
      await insertBooking(cl, t, { customerId: c.id, from: at(700), to: at(760), depositPaise: 1000, status: "CANCELLED" });
      await insertBooking(cl, t, { customerId: c.id, from: at(800), to: at(860), depositPaise: 0 });
    });
    const b = await call(db, ctx, getCustomerBalance, { customerId: c.id });
    assert.deepEqual(b.balances, [{ currency: "INR", ordersOutstandingPaise: 0, depositsOutstandingPaise: 1500, totalOutstandingPaise: 1500 }]);
  });

  test("a customer with nothing owed has no balance lines; amounts are integers", async () => {
    const t = await db.createTenant("crm-balance-none");
    const c = await newCustomer(t, "Clear");
    const b = await call(db, makeCtx(t), getCustomerBalance, { customerId: c.id });
    assert.deepEqual(b.balances, []);
    await tx(db, t, (cl) => insertOrder(cl, t, { customerId: c.id, totalPaise: 123 }));
    const b2 = await call(db, makeCtx(t), getCustomerBalance, { customerId: c.id });
    assert.ok(b2.balances.every((l) => Number.isInteger(l.totalOutstandingPaise)));
    assert.equal(b2.balances[0]?.totalOutstandingPaise, 123);
  });
});
