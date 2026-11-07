import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  addCustomerTag, archiveCustomer, createCustomer, getCustomer, listTags, removeCustomerTag, restoreCustomer, searchCustomers,
  searchCustomersForAi, updateCustomer,
} from "../src/index.ts";
import { NOW, at, call, connectTestDb, insertBooking, makeCtx, rejectsWith, tx, type TestDb } from "./helpers.ts";
import { PrincipalKind } from "@qenbel/shared";

let db: TestDb;
before(async () => {
  db = await connectTestDb();
});
after(async () => {
  await db.close();
});

async function events(tenantId: string, aggregateId?: string) {
  return tx(db, tenantId, async (c) => {
    const res = await c.query<{ type: string; aggregate_type: string; aggregate_id: string; payload: Record<string, unknown>; status: string; event_id: string }>(
      "select type, aggregate_type, aggregate_id, payload, status, event_id from outbox_events where tenant_id = $1 and ($2::uuid is null or aggregate_id = $2) order by created_at",
      [tenantId, aggregateId ?? null],
    );
    return res.rows;
  });
}

describe("createCustomer", () => {
  test("stores a normalised customer and writes customer.created once, with masked contact only", async () => {
    const t = await db.createTenant("cust-create");
    const ctx = makeCtx(t);
    const r = await call(db, ctx, createCustomer, {
      name: "  Asha Rao ", phone: "98765 43210", email: "Asha.Rao@Example.COM", dateOfBirth: "1990-04-02", address: "12 Example Road",
      notes: "Prefers mornings", tags: ["VIP", "vip", "Regular"], attributes: { allergies: "nuts" }, consentMarketing: true,
    });
    assert.equal(r.created, true);
    assert.equal(r.matchedBy, null);
    const c = r.customer;
    assert.equal(c.name, "Asha Rao");
    assert.equal(c.phone, "+919876543210");
    assert.equal(c.email, "asha.rao@example.com");
    assert.equal(c.dateOfBirth, "1990-04-02");
    assert.equal(c.address, "12 Example Road");
    assert.deepEqual(c.attributes, { allergies: "nuts" });
    assert.deepEqual(c.tags, ["regular", "vip"]);
    assert.equal(c.source, "dashboard");
    assert.equal(c.consentMarketing, true);
    assert.equal(c.archivedAt, null);

    const ev = await events(t);
    assert.equal(ev.length, 1);
    const e = ev[0]!;
    assert.equal(e.type, "customer.created");
    assert.equal(e.aggregate_type, "customer");
    assert.equal(e.aggregate_id, c.id);
    assert.equal(e.status, "pending");
    const payload = JSON.stringify(e.payload);
    assert.ok(!payload.includes("9876543210"), "full phone must not be in the event");
    assert.ok(!payload.includes("asha.rao@example.com"), "full email must not be in the event");
    assert.equal(e.payload.phoneMasked, "******3210");
  });

  test("source defaults to the actor's channel and can be set", async () => {
    const t = await db.createTenant("cust-source");
    const a = await call(db, makeCtx(t, { channel: "api" }), createCustomer, { name: "A" });
    assert.equal(a.customer.source, "api");
    const b = await call(db, makeCtx(t), createCustomer, { name: "B", source: "voice" });
    assert.equal(b.customer.source, "voice");
  });

  test("a second create with the same phone in any spelling returns the first, writes no second event", async () => {
    const t = await db.createTenant("cust-dedupe");
    const ctx = makeCtx(t);
    const first = await call(db, ctx, createCustomer, { name: "First", phone: "+919876543210" });
    for (const spelling of ["9876543210", "098765 43210", "+91 98765-43210", "919876543210"]) {
      const again = await call(db, ctx, createCustomer, { name: "Other name", phone: spelling });
      assert.equal(again.created, false, spelling);
      assert.equal(again.matchedBy, "phone");
      assert.equal(again.customer.id, first.customer.id);
      assert.equal(again.customer.name, "First", "the existing record is returned unchanged");
    }
    assert.equal((await events(t)).length, 1);
    const all = await call(db, ctx, searchCustomers, {});
    assert.equal(all.items.length, 1);
  });

  test("matches by email, case-insensitively", async () => {
    const t = await db.createTenant("cust-email");
    const ctx = makeCtx(t);
    const first = await call(db, ctx, createCustomer, { name: "E", email: "e@example.com" });
    const again = await call(db, ctx, createCustomer, { name: "E2", email: "E@Example.com" });
    assert.equal(again.created, false);
    assert.equal(again.matchedBy, "email");
    assert.equal(again.customer.id, first.customer.id);
  });

  test("phone matching one customer and email another is ambiguous: CONFLICT lists both candidates", async () => {
    const t = await db.createTenant("cust-ambig");
    const ctx = makeCtx(t);
    const a = await call(db, ctx, createCustomer, { name: "A", phone: "+919876543210" });
    const b = await call(db, ctx, createCustomer, { name: "B", email: "b@example.com" });
    const err = await rejectsWith(call(db, ctx, createCustomer, { name: "C", phone: "9876543210", email: "b@example.com" }), "CONFLICT");
    assert.deepEqual([...(err.details.candidates as string[])].sort(), [a.customer.id, b.customer.id].sort());
    assert.equal((await events(t)).length, 2, "no event for the refused create");
  });

  test("the same phone in two tenants is two customers (dedupe is per tenant)", async () => {
    const ta = await db.createTenant("cust-dd-a");
    const tb = await db.createTenant("cust-dd-b");
    const a = await call(db, makeCtx(ta), createCustomer, { name: "Same", phone: "9876543210" });
    const b = await call(db, makeCtx(tb), createCustomer, { name: "Same", phone: "9876543210" });
    assert.equal(a.created, true);
    assert.equal(b.created, true);
    assert.notEqual(a.customer.id, b.customer.id);
  });

  test("8 concurrent creates of one phone give one customer and one event", async () => {
    const t = await db.createTenant("cust-race");
    const ctx = makeCtx(t);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => call(db, ctx, createCustomer, { name: `Racer ${i}`, phone: i % 2 ? "9876543210" : "+91 98765 43210" })),
    );
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.customer.id)).size, 1);
    assert.equal((await events(t)).length, 1);
  });

  test("a rolled-back transaction leaves neither the customer nor the event", async () => {
    const t = await db.createTenant("cust-rollback");
    const ctx = makeCtx(t);
    await assert.rejects(
      tx(db, t, async (c) => {
        await createCustomer(c, ctx, { name: "Ghost", phone: "9876543210" });
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal((await events(t)).length, 0);
    assert.equal((await call(db, ctx, searchCustomers, {})).items.length, 0);
  });

  test("refuses a phone that cannot be normalised, naming the field", async () => {
    const t = await db.createTenant("cust-badphone");
    const err = await rejectsWith(call(db, makeCtx(t), createCustomer, { name: "X", phone: "12345" }), "VALIDATION_FAILED");
    const issues = err.details.issues as Array<{ path: string; message: string }>;
    assert.ok(issues.some((i) => i.path === "phone"));
    assert.ok(!JSON.stringify(err).includes("12345"), "input values are not echoed");
  });

  test("strict input: tenantId, role and unknown keys are rejected before any write", async () => {
    const t = await db.createTenant("cust-strict");
    const other = await db.createTenant("cust-strict-other");
    const ctx = makeCtx(t);
    for (const extra of [{ tenantId: other }, { tenant_id: other }, { role: "OWNER" }, { id: other }, { unknown: 1 }]) {
      await rejectsWith(call(db, ctx, createCustomer, { name: "Smuggler", ...extra } as never), "VALIDATION_FAILED");
    }
    assert.equal((await call(db, ctx, searchCustomers, {})).items.length, 0);
    assert.equal((await call(db, makeCtx(other), searchCustomers, {})).items.length, 0);
  });

  test("reserved attribute keys, oversized and non-plain values are refused", async () => {
    const t = await db.createTenant("cust-attrs");
    const ctx = makeCtx(t);
    await rejectsWith(call(db, ctx, createCustomer, { name: "X", attributes: { dateOfBirth: "x" } }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCustomer, { name: "X", attributes: { nested: { a: 1 } } } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCustomer, { name: "" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCustomer, { name: "x".repeat(121) }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCustomer, { name: "X", dateOfBirth: "1990-02-30" }), "VALIDATION_FAILED");
  });

  test("a context without a valid tenant id is refused", async () => {
    const t = await db.createTenant("cust-noctx");
    const bad = { ...makeCtx(t), tenantId: "not-a-uuid" };
    await rejectsWith(tx(db, t, (c) => createCustomer(c, bad, { name: "X" })), "TENANT_REQUIRED");
  });
});

describe("updateCustomer", () => {
  test("changes fields, normalises, clears with null, keeps other attributes", async () => {
    const t = await db.createTenant("cust-update");
    const ctx = makeCtx(t);
    const { customer } = await call(db, ctx, createCustomer, {
      name: "U", phone: "9876543210", email: "u@example.com", dateOfBirth: "1991-01-01", attributes: { a: "1", b: "2" },
    });
    const u = await call(db, ctx, updateCustomer, {
      customerId: customer.id, name: "U2", phone: "+44 7911 123456", dateOfBirth: null, attributes: { a: null, c: true }, consentMarketing: true,
    });
    assert.equal(u.name, "U2");
    assert.equal(u.phone, "+447911123456");
    assert.equal(u.email, "u@example.com");
    assert.equal(u.dateOfBirth, null);
    assert.deepEqual(u.attributes, { b: "2", c: true });
    assert.equal(u.consentMarketing, true);
    const cleared = await call(db, ctx, updateCustomer, { customerId: customer.id, email: null, phone: null });
    assert.equal(cleared.email, null);
    assert.equal(cleared.phone, null);
  });

  test("moving onto another active customer's phone or email is a CONFLICT naming that customer", async () => {
    const t = await db.createTenant("cust-upd-conflict");
    const ctx = makeCtx(t);
    const a = (await call(db, ctx, createCustomer, { name: "A", phone: "9876543210", email: "a@example.com" })).customer;
    const b = (await call(db, ctx, createCustomer, { name: "B", phone: "9123456789" })).customer;
    const e1 = await rejectsWith(call(db, ctx, updateCustomer, { customerId: b.id, phone: "+91 98765 43210" }), "CONFLICT");
    assert.equal(e1.details.customerId, a.id);
    assert.equal(e1.details.field, "phone");
    const e2 = await rejectsWith(call(db, ctx, updateCustomer, { customerId: b.id, email: "A@example.com" }), "CONFLICT");
    assert.equal(e2.details.field, "email");
    // re-sending its own number is not a conflict
    const same = await call(db, ctx, updateCustomer, { customerId: a.id, phone: "9876543210" });
    assert.equal(same.phone, "+919876543210");
  });

  test("an update needs at least one field, and an archived customer must be restored first", async () => {
    const t = await db.createTenant("cust-upd-misc");
    const ctx = makeCtx(t);
    const c = (await call(db, ctx, createCustomer, { name: "Z", phone: "9876543210" })).customer;
    await rejectsWith(call(db, ctx, updateCustomer, { customerId: c.id }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, updateCustomer, { customerId: c.id, name: "Q", tenantId: t } as never), "VALIDATION_FAILED");
    await call(db, ctx, archiveCustomer, { customerId: c.id });
    await rejectsWith(call(db, ctx, updateCustomer, { customerId: c.id, name: "Q" }), "CONFLICT");
  });
});

describe("archive semantics", () => {
  test("archived customers are hidden from search and AI search, still readable, and archive is idempotent", async () => {
    const t = await db.createTenant("cust-archive");
    const ctx = makeCtx(t);
    const c = (await call(db, ctx, createCustomer, { name: "Gone Person", phone: "9876543210", email: "gone@example.com", tags: ["old"] })).customer;
    const first = await call(db, ctx, archiveCustomer, { customerId: c.id });
    assert.ok(first.archivedAt);
    const second = await call(db, makeCtx(t, { now: new Date(NOW.getTime() + 86_400_000) }), archiveCustomer, { customerId: c.id });
    assert.equal(second.archivedAt, first.archivedAt, "a second archive does not move the timestamp");

    assert.equal((await call(db, ctx, searchCustomers, { query: "gone" })).items.length, 0);
    assert.equal((await call(db, ctx, searchCustomers, { phone: "9876543210" })).items.length, 0);
    assert.equal((await call(db, ctx, searchCustomers, { tag: "old" })).items.length, 0);
    assert.equal((await call(db, ctx, searchCustomersForAi, { phone: "9876543210" })).customers.length, 0);
    assert.equal((await call(db, ctx, searchCustomers, { query: "gone", archived: "include" })).items.length, 1);
    assert.equal((await call(db, ctx, searchCustomers, { archived: "only" })).items.length, 1);
    assert.deepEqual((await call(db, ctx, listTags, {})), [], "archived customers do not count in tag totals");
    const read = await call(db, ctx, getCustomer, { customerId: c.id });
    assert.equal(read.name, "Gone Person");
    assert.ok(read.archivedAt);
  });

  test("a new customer may reuse an archived one's phone; restoring the old one is then refused", async () => {
    const t = await db.createTenant("cust-archive-reuse");
    const ctx = makeCtx(t);
    const old = (await call(db, ctx, createCustomer, { name: "Old", phone: "9876543210" })).customer;
    await call(db, ctx, archiveCustomer, { customerId: old.id });
    const fresh = await call(db, ctx, createCustomer, { name: "New", phone: "9876543210" });
    assert.equal(fresh.created, true);
    assert.notEqual(fresh.customer.id, old.id);
    const err = await rejectsWith(call(db, ctx, restoreCustomer, { customerId: old.id }), "CONFLICT");
    assert.equal(err.details.customerId, fresh.customer.id);
    await call(db, ctx, archiveCustomer, { customerId: fresh.customer.id });
    const restored = await call(db, ctx, restoreCustomer, { customerId: old.id });
    assert.equal(restored.archivedAt, null);
  });

  test("unknown ids are NOT_FOUND", async () => {
    const t = await db.createTenant("cust-archive-nf");
    const ctx = makeCtx(t);
    const ghost = "11111111-1111-1111-1111-111111111111";
    for (const fn of [archiveCustomer, restoreCustomer, getCustomer]) await rejectsWith(call(db, ctx, fn, { customerId: ghost }), "NOT_FOUND");
  });
});

describe("searchCustomers (staff)", () => {
  test("matches partial name, partial phone digits and partial email; LIKE wildcards are literal", async () => {
    const t = await db.createTenant("cust-search");
    const ctx = makeCtx(t);
    await call(db, ctx, createCustomer, { name: "Meera Nair", phone: "9876501234", email: "meera@example.com" });
    await call(db, ctx, createCustomer, { name: "Ravi Kumar", phone: "9123456789", email: "ravi@sample.org" });
    await call(db, ctx, createCustomer, { name: "100% Fan_Club" });
    const names = async (q: Record<string, unknown>) => (await call(db, ctx, searchCustomers, q as never)).items.map((c) => c.name);
    assert.deepEqual(await names({ query: "mee" }), ["Meera Nair"]);
    assert.deepEqual(await names({ query: "NAIR" }), ["Meera Nair"]);
    assert.deepEqual(await names({ query: "5012" }), ["Meera Nair"]);
    assert.deepEqual(await names({ query: "+91 98765" }), ["Meera Nair"]);
    assert.deepEqual(await names({ query: "sample.org" }), ["Ravi Kumar"]);
    assert.deepEqual(await names({ phone: "09123456789" }), ["Ravi Kumar"]);
    assert.deepEqual(await names({ email: "MEERA@example.com" }), ["Meera Nair"]);
    assert.deepEqual(await names({ query: "%" }), ["100% Fan_Club"], "% is literal, not a wildcard");
    assert.deepEqual(await names({ query: "_" }), ["100% Fan_Club"], "_ is literal, not a wildcard");
    assert.deepEqual(await names({ query: "zzz" }), []);
    assert.equal((await names({})).length, 3);
  });

  test("returns full records, tag filter works, tags are listed with counts", async () => {
    const t = await db.createTenant("cust-search-tag");
    const ctx = makeCtx(t);
    const a = (await call(db, ctx, createCustomer, { name: "A", phone: "9876543210", tags: ["vip"] })).customer;
    await call(db, ctx, createCustomer, { name: "B", phone: "9123456789", tags: ["vip", "walk-in"] });
    await call(db, ctx, createCustomer, { name: "C" });
    const vip = await call(db, ctx, searchCustomers, { tag: "VIP" });
    assert.equal(vip.items.length, 2);
    assert.equal(vip.items.find((c) => c.id === a.id)?.phone, "+919876543210");
    assert.deepEqual(await call(db, ctx, listTags, {}), [{ tag: "vip", customers: 2 }, { tag: "walk-in", customers: 1 }]);
  });

  test("pages are stable, complete and duplicate free; bad cursors are refused", async () => {
    const t = await db.createTenant("cust-page");
    const ctx = makeCtx(t);
    const names = ["Zed", "alpha", "Bravo", "charlie", "Delta", "echo", "Foxtrot"];
    for (const n of names) await call(db, ctx, createCustomer, { name: n });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await call(db, ctx, searchCustomers, { limit: 3, ...(cursor ? { cursor } : {}) });
      assert.ok(page.items.length <= 3);
      seen.push(...page.items.map((c) => c.name));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, ["alpha", "Bravo", "charlie", "Delta", "echo", "Foxtrot", "Zed"]);
    for (const bad of ["garbage", "e30", Buffer.from('["only-one"]').toString("base64url"), Buffer.from("[1,2]").toString("base64url")]) {
      await rejectsWith(call(db, ctx, searchCustomers, { cursor: bad }), "VALIDATION_FAILED");
    }
    await rejectsWith(call(db, ctx, searchCustomers, { limit: 101 }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, searchCustomers, { limit: 0 }), "VALIDATION_FAILED");
  });

  test("a cursor from one tenant cannot be used to read another tenant's rows", async () => {
    const ta = await db.createTenant("cust-cur-a");
    const tb = await db.createTenant("cust-cur-b");
    for (const n of ["a1", "a2", "a3"]) await call(db, makeCtx(ta), createCustomer, { name: n });
    for (const n of ["b1", "b2", "b3"]) await call(db, makeCtx(tb), createCustomer, { name: n });
    const pageA = await call(db, makeCtx(ta), searchCustomers, { limit: 1 });
    const viaB = await call(db, makeCtx(tb), searchCustomers, { limit: 5, cursor: pageA.nextCursor as string });
    assert.ok(viaB.items.every((c) => c.name.startsWith("b")));
  });
});

describe("searchCustomersForAi", () => {
  test("returns only the minimal masked fields; full phone and email never appear", async () => {
    const t = await db.createTenant("cust-ai");
    const ctx = makeCtx(t);
    const c = (await call(db, ctx, createCustomer, {
      name: "Priya Sharma", phone: "9876543210", email: "priya.sharma@example.com", dateOfBirth: "1992-02-02", address: "Secret Street 1",
      notes: "private note", tags: ["vip"], attributes: { allergies: "nuts" },
    })).customer;
    const r = await call(db, ctx, searchCustomersForAi, { phone: "98765 43210" });
    assert.equal(r.customers.length, 1);
    const hit = r.customers[0]!;
    assert.deepEqual(Object.keys(hit).sort(), ["customerId", "displayName", "emailMasked", "hasUpcomingBooking", "phoneMasked"]);
    assert.equal(hit.customerId, c.id);
    assert.equal(hit.displayName, "Priya");
    assert.equal(hit.phoneMasked, "******3210");
    assert.equal(hit.emailMasked, "p***@example.com");
    const wire = JSON.stringify(r);
    for (const secret of ["9876543210", "priya.sharma", "Sharma", "1992", "Secret Street", "private note", "nuts", "vip"]) {
      assert.ok(!wire.includes(secret), `AI output must not contain "${secret}"`);
    }
  });

  test("needs a filter, never lists everyone, caps at 5, name is a partial match, email exact", async () => {
    const t = await db.createTenant("cust-ai-limits");
    const ctx = makeCtx(t);
    for (let i = 0; i < 8; i++) await call(db, ctx, createCustomer, { name: `Sam Person ${i}` });
    await call(db, ctx, createCustomer, { name: "Other", email: "other@example.com" });
    await rejectsWith(call(db, ctx, searchCustomersForAi, {}), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, searchCustomersForAi, { name: "S" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, searchCustomersForAi, { name: "Sam", limit: 6 }), "VALIDATION_FAILED");
    assert.equal((await call(db, ctx, searchCustomersForAi, { name: "sam" })).customers.length, 3, "default limit is 3");
    assert.equal((await call(db, ctx, searchCustomersForAi, { name: "sam", limit: 5 })).customers.length, 5);
    assert.equal((await call(db, ctx, searchCustomersForAi, { email: "OTHER@example.com" })).customers.length, 1);
    assert.equal((await call(db, ctx, searchCustomersForAi, { email: "oth@example.com" })).customers.length, 0, "email is not a partial match");
    assert.equal((await call(db, ctx, searchCustomersForAi, { name: "%%" })).customers.length, 0, "wildcards are literal");
  });

  test("hasUpcomingBooking is true only for live future bookings", async () => {
    const t = await db.createTenant("cust-ai-upcoming");
    const ctx = makeCtx(t);
    const mk = async (name: string, phone: string) => (await call(db, ctx, createCustomer, { name, phone })).customer.id;
    const future = await mk("Future", "9000000001");
    const past = await mk("Past", "9000000002");
    const expired = await mk("Expired", "9000000003");
    const cancelled = await mk("Cancelled", "9000000004");
    const live = await mk("LiveHold", "9000000005");
    await tx(db, t, async (c) => {
      await insertBooking(c, t, { customerId: future, from: at(600), to: at(660) });
      await insertBooking(c, t, { customerId: past, from: new Date(NOW.getTime() - 7200_000), to: new Date(NOW.getTime() - 3600_000) });
      await insertBooking(c, t, { customerId: expired, from: at(600), to: at(660), status: "HOLD", holdExpiresAt: new Date(NOW.getTime() - 60_000) });
      await insertBooking(c, t, { customerId: cancelled, from: at(600), to: at(660), status: "CANCELLED" });
      await insertBooking(c, t, { customerId: live, from: at(600), to: at(660), status: "HOLD", holdExpiresAt: new Date(NOW.getTime() + 600_000) });
    });
    const flag = async (phone: string) => (await call(db, ctx, searchCustomersForAi, { phone })).customers[0]!.hasUpcomingBooking;
    assert.equal(await flag("9000000001"), true);
    assert.equal(await flag("9000000002"), false);
    assert.equal(await flag("9000000003"), false);
    assert.equal(await flag("9000000004"), false);
    assert.equal(await flag("9000000005"), true);
  });

  test("strict input", async () => {
    const t = await db.createTenant("cust-ai-strict");
    await rejectsWith(call(db, makeCtx(t), searchCustomersForAi, { name: "Sam", tenantId: t } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, makeCtx(t), searchCustomersForAi, { phone: "bogus" }), "VALIDATION_FAILED");
  });
});

describe("tags", () => {
  test("add is idempotent and lowercases, remove is idempotent, cap is enforced", async () => {
    const t = await db.createTenant("cust-tags");
    const ctx = makeCtx(t);
    const c = (await call(db, ctx, createCustomer, { name: "T" })).customer;
    await call(db, ctx, addCustomerTag, { customerId: c.id, tag: "VIP" });
    const twice = await call(db, ctx, addCustomerTag, { customerId: c.id, tag: " vip " });
    assert.deepEqual(twice.tags, ["vip"]);
    const removed = await call(db, ctx, removeCustomerTag, { customerId: c.id, tag: "VIP" });
    assert.deepEqual(removed.tags, []);
    await call(db, ctx, removeCustomerTag, { customerId: c.id, tag: "vip" });
    for (let i = 0; i < 50; i++) await call(db, ctx, addCustomerTag, { customerId: c.id, tag: `t${i}` });
    await rejectsWith(call(db, ctx, addCustomerTag, { customerId: c.id, tag: "one-too-many" }), "CONFLICT");
    await rejectsWith(call(db, ctx, addCustomerTag, { customerId: c.id, tag: "" }), "VALIDATION_FAILED");
  });
});

describe("tenant isolation", () => {
  test("tenant A's context can neither see nor change tenant B's customers", async () => {
    const ta = await db.createTenant("cust-iso-a");
    const tb = await db.createTenant("cust-iso-b");
    const ctxA = makeCtx(ta);
    const ctxB = makeCtx(tb);
    const a = (await call(db, ctxA, createCustomer, { name: "Alice A", phone: "9000000010", email: "alice@a.example", tags: ["ta"] })).customer;
    const b = (await call(db, ctxB, createCustomer, { name: "Bob B", phone: "9000000011", email: "bob@b.example", tags: ["tb"] })).customer;

    for (const fn of [getCustomer, archiveCustomer, restoreCustomer]) {
      await rejectsWith(call(db, ctxA, fn, { customerId: b.id }), "NOT_FOUND");
    }
    await rejectsWith(call(db, ctxA, updateCustomer, { customerId: b.id, name: "Hijacked" }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, addCustomerTag, { customerId: b.id, tag: "x" }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, removeCustomerTag, { customerId: b.id, tag: "tb" }), "NOT_FOUND");

    const listA = await call(db, ctxA, searchCustomers, { archived: "include" });
    assert.deepEqual(listA.items.map((c) => c.id), [a.id]);
    assert.equal((await call(db, ctxA, searchCustomers, { phone: "9000000011" })).items.length, 0);
    assert.equal((await call(db, ctxA, searchCustomers, { query: "bob" })).items.length, 0);
    assert.equal((await call(db, ctxA, searchCustomers, { tag: "tb" })).items.length, 0);
    assert.equal((await call(db, ctxA, searchCustomersForAi, { phone: "9000000011" })).customers.length, 0);
    assert.equal((await call(db, ctxA, searchCustomersForAi, { email: "bob@b.example" })).customers.length, 0);
    assert.deepEqual(await call(db, ctxA, listTags, {}), [{ tag: "ta", customers: 1 }]);

    // B is untouched
    const bAfter = await call(db, ctxB, getCustomer, { customerId: b.id });
    assert.equal(bAfter.name, "Bob B");
    assert.equal(bAfter.archivedAt, null);
    assert.deepEqual(bAfter.tags, ["tb"]);
    assert.equal((await events(tb)).length, 1);
    assert.equal((await events(ta)).length, 1);
  });

  test("a mismatched client and context cannot cross tenants: reads see nothing, writes are refused by RLS", async () => {
    const ta = await db.createTenant("cust-mm-a");
    const tb = await db.createTenant("cust-mm-b");
    const b = (await call(db, makeCtx(tb), createCustomer, { name: "Bob", phone: "9000000020" })).customer;
    // client scoped to tenant A, context claims tenant B
    await assert.rejects(tx(db, ta, (c) => getCustomer(c, makeCtx(tb), { customerId: b.id })), (e: { code?: string }) => e.code === "NOT_FOUND");
    await assert.rejects(tx(db, ta, (c) => createCustomer(c, makeCtx(tb), { name: "Planted" })), (e: { code?: string }) => e.code === "42501");
    assert.equal((await call(db, makeCtx(tb), searchCustomers, {})).items.length, 1, "nothing was planted in tenant B");
    // client scoped to B, context claims A: nothing of B is visible through A's id
    const seen = await tx(db, tb, (c) => searchCustomers(c, makeCtx(ta), {}));
    assert.equal(seen.items.length, 0);
  });

  test("actor kind decides note authorship only for real users (no foreign key error for API credentials)", async () => {
    const t = await db.createTenant("cust-actor");
    const ctx = makeCtx(t, { kind: PrincipalKind.API_CREDENTIAL, actorId: "11111111-2222-3333-4444-555555555555" });
    const r = await call(db, ctx, createCustomer, { name: "Via API", notes: "from a credential" });
    assert.equal(r.created, true);
  });
});
