// Security regression tests (docs/security/REVIEW-stage2.md): SEC-006 customer lookup on customer channels, the staff-only
// gate on every other function, subject-bound escalation and communication log, AI-safe catalogue, input caps and
// prototype-pollution checks. The SEC-006 tests mirror the proof of concept in docs/security/poc/engine-abuse.test.ts.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as engine from "../src/index.ts";
import {
  archiveCustomer, createCatalogueItem, createCategory, createCustomer, createFollowUp, createVariant, getCatalogueForChannel, listCatalogueItems,
  listCustomerNotes, listFollowUps, listResources, logCommunication, searchCustomers, searchCustomersForAi, updateCategory, updateVariant,
  createResource, getBusinessProfileForChannel, updateResource, listCommunications,
} from "../src/index.ts";
import { mapPgError } from "../src/common.ts";
import { at, call, connectTestDb, insertBooking, insertOrder, makeCtx, rejectsWith, tx, type TestDb } from "./helpers.ts";

let db: TestDb;
before(async () => {
  db = await connectTestDb();
});
after(async () => {
  await db.close();
});

const CUSTOMER_CHANNELS = ["web_chat", "whatsapp", "voice"] as const;
const UNKNOWN_CHANNEL = "telegram" as never;

interface Pair {
  t: string;
  alice: string;
  bob: string;
}

/** The PoC's tenant: Alice Anand (+919811100001) and Bob Bhat (+919811100002), Bob with an upcoming booking. */
async function seedPair(prefix: string): Promise<Pair> {
  const t = await db.createTenant(prefix);
  const staff = makeCtx(t);
  const alice = (await call(db, staff, createCustomer, { name: "Alice Anand", phone: "+919811100001", email: "alice@example.com" })).customer.id;
  const bob = (await call(db, staff, createCustomer, { name: "Bob Bhat", phone: "+919811100002", email: "bob@example.com" })).customer.id;
  await tx(db, t, (c) => insertBooking(c, t, { customerId: bob, from: at(600), to: at(660) }));
  return { t, alice, bob };
}

const asChannel = (p: Pair, channel: string, subject?: { customerId?: string; conversationId?: string }) =>
  makeCtx(p.t, { channel: channel as never, kind: "api_credential" as never, actorId: "cred-1", ...(subject ? { subject } : {}) });

describe("SEC-006: customer lookup on customer channels", () => {
  test("without a verified subject nothing is found, by name, phone or e-mail, on every customer channel (the PoC)", async () => {
    const p = await seedPair("sg-nosub");
    for (const channel of [...CUSTOMER_CHANNELS, UNKNOWN_CHANNEL]) {
      const ctx = asChannel(p, channel);
      const byName = await call(db, ctx, searchCustomersForAi, { name: "bh" });
      const byPhone = await call(db, ctx, searchCustomersForAi, { phone: "+919811100001" });
      const byEmail = await call(db, ctx, searchCustomersForAi, { email: "bob@example.com" });
      assert.deepEqual([byName, byPhone, byEmail], [{ customers: [] }, { customers: [] }, { customers: [] }], `${channel} must not find anyone`);
    }
  });

  test("with no subject the engine does not even run SQL, and the answer equals the answer for a miss", async () => {
    const t = randomUUID();
    const poisoned = { query: () => { throw new Error("SQL must not be reached"); } };
    for (const channel of [...CUSTOMER_CHANNELS, UNKNOWN_CHANNEL]) {
      const ctx = makeCtx(t, { channel: channel as never });
      assert.deepEqual(await searchCustomersForAi(poisoned, ctx, { phone: "+919811100001" }), { customers: [] });
      // a subject that is not a plain uuid, or only a conversation id, is the same as none
      for (const subject of [{ customerId: "x' or '1'='1" }, { customerId: "" }, { conversationId: randomUUID() }, { customerId: 5 as never }]) {
        assert.deepEqual(await searchCustomersForAi(poisoned, makeCtx(t, { channel: channel as never, subject }), { name: "Alice" }), { customers: [] });
      }
    }
  });

  test("with a verified subject, only that customer's own record can come back, whatever is asked", async () => {
    const p = await seedPair("sg-subject");
    for (const channel of CUSTOMER_CHANNELS) {
      const asAlice = asChannel(p, channel, { customerId: p.alice });
      // other people: by name fragment, by phone, by e-mail, and by a mix that names both
      for (const input of [
        { name: "bh" }, { name: "Bob" }, { phone: "+919811100002" }, { phone: "9811100002" }, { email: "bob@example.com" },
        { phone: "+919811100001", email: "bob@example.com" }, { name: "Alice", phone: "+919811100002" },
      ]) {
        assert.deepEqual(await call(db, asAlice, searchCustomersForAi, input), { customers: [] }, `${channel} ${JSON.stringify(input)}`);
      }
      // herself: found only when what was claimed matches
      for (const input of [{ phone: "+919811100001" }, { phone: "98111 00001" }, { email: "ALICE@example.com" }, { name: "ali" }, { name: "anand" }, { name: "Alice", phone: "9811100001" }]) {
        const r = await call(db, asAlice, searchCustomersForAi, input);
        assert.equal(r.customers.length, 1, `${channel} ${JSON.stringify(input)}`);
        assert.deepEqual(r.customers[0], { customerId: p.alice, displayName: "Alice", phoneMasked: "******0001", emailMasked: "a***@example.com", hasUpcomingBooking: false });
      }
    }
  });

  test("a name matching several customers still returns only the subject; Bob's booking flag is unreachable", async () => {
    const p = await seedPair("sg-several");
    const staff = makeCtx(p.t);
    for (let i = 0; i < 4; i++) await call(db, staff, createCustomer, { name: `Sam Person ${i}` });
    const sam = (await call(db, staff, createCustomer, { name: "Sam Subject" })).customer.id;
    const r = await call(db, asChannel(p, "web_chat", { customerId: sam }), searchCustomersForAi, { name: "sam", limit: 5 });
    assert.deepEqual(r.customers.map((c) => c.customerId), [sam]);
    // Bob has an upcoming booking; as himself it shows, as Alice it can never be read
    assert.equal((await call(db, asChannel(p, "whatsapp", { customerId: p.bob }), searchCustomersForAi, { phone: "+919811100002" })).customers[0]!.hasUpcomingBooking, true);
    assert.deepEqual(await call(db, asChannel(p, "whatsapp", { customerId: p.alice }), searchCustomersForAi, { phone: "+919811100002" }), { customers: [] });
  });

  test("an archived subject, a subject from another tenant and an unknown subject get the same empty answer", async () => {
    const p = await seedPair("sg-gone");
    const other = await seedPair("sg-gone-o");
    const staff = makeCtx(p.t);
    assert.deepEqual(await call(db, asChannel(p, "whatsapp", { customerId: other.alice }), searchCustomersForAi, { phone: "+919811100001" }), { customers: [] }, "the other tenant's Alice shares the number but is not ours");
    assert.deepEqual(await call(db, asChannel(p, "whatsapp", { customerId: randomUUID() }), searchCustomersForAi, { phone: "+919811100001" }), { customers: [] });
    await call(db, staff, archiveCustomer, { customerId: p.alice });
    assert.deepEqual(await call(db, asChannel(p, "whatsapp", { customerId: p.alice }), searchCustomersForAi, { phone: "+919811100001" }), { customers: [] }, "archived customers do not leak");
  });

  test("LIKE wildcards stay literal and input stays bounded and strict on customer channels", async () => {
    const p = await seedPair("sg-like");
    const ctx = asChannel(p, "whatsapp", { customerId: p.alice });
    for (const q of ["%%", "__", "\\%", "a%", "_l"]) assert.deepEqual(await call(db, ctx, searchCustomersForAi, { name: q }), { customers: [] }, JSON.stringify(q));
    await rejectsWith(call(db, ctx, searchCustomersForAi, { name: "x".repeat(121) }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, searchCustomersForAi, { name: "A" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, searchCustomersForAi, { name: "Alice", limit: 6 }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, searchCustomersForAi, {}), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, searchCustomersForAi, { name: "Alice", customerId: p.bob } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, searchCustomersForAi, { name: "Alice", subject: { customerId: p.bob } } as never), "VALIDATION_FAILED");
  });

  test("trusted channels (dashboard, api) keep the tenant-wide minimal lookup; a subject there is ignored", async () => {
    const p = await seedPair("sg-dash");
    for (const channel of ["dashboard", "api"] as const) {
      const r = await call(db, asChannel(p, channel, { customerId: p.alice }), searchCustomersForAi, { name: "bh" });
      assert.deepEqual(r.customers.map((c) => c.customerId), [p.bob], channel);
      assert.ok(!JSON.stringify(r).includes("+919811100002"));
    }
  });
});

// Every engine function is either staff-only or on this list; a new export must make that choice explicitly.
const PURE_OR_INTERNAL = new Set([
  "breaksOf", "emptyWeek", "generateAllSlots", "generateResourceSlots", "intersectIntervals", "maskEmail", "maskPhone", "normaliseEmail", "normalisePhone",
  "peakUnits", "readSettings", "slotRequestFor", "weekFromRows", "insertNote", "readLocationHours", "loadWeeklyBreaks",
]);
/** The only functions a customer channel may call, and why. */
const CHANNEL_OPS = new Set([
  "searchCustomersForAi", // bound to ctx.subject
  "getCatalogueForChannel", // whitelisted fields
  "getBusinessProfileForChannel", // whitelisted fields
  "loadAvailabilityInputs", // booking engine's slot inputs: no customer data, no time off reasons
  "createFollowUp", // escalation, bound to ctx.subject
  "logCommunication", // conversation log, bound to ctx.subject
]);
const NO_INPUT = new Set(["getBusinessProfile", "getBusinessProfileForChannel"]);
const allOps = Object.entries(engine).filter(([name, v]) => typeof v === "function" && !PURE_OR_INTERNAL.has(name)) as Array<[string, (...a: unknown[]) => Promise<unknown>]>;
const staffOps = allOps.filter(([name]) => !CHANNEL_OPS.has(name));

describe("staff-only functions are closed to customer channels", () => {
  const poisoned = { query: () => { throw new Error("SQL must not be reached"); } };

  test("the classification is complete", () => {
    assert.ok(staffOps.length >= 60, `found ${staffOps.length} staff ops`);
    for (const name of CHANNEL_OPS) assert.ok(allOps.some(([n]) => n === name), `${name} is exported`);
  });

  test("every staff function is FORBIDDEN on web_chat, whatsapp, voice and unknown channels, before validation, SQL or any lookup", async () => {
    const t = randomUUID();
    for (const channel of [...CUSTOMER_CHANNELS, UNKNOWN_CHANNEL, "" as never, undefined as never]) {
      const base = makeCtx(t);
      const ctx = { ...base, actor: { ...base.actor, channel } };
      for (const [name, fn] of staffOps) {
        // valid-looking or empty input makes no difference: the refusal comes first, so an id probe learns nothing
        for (const input of [{}, { customerId: randomUUID() }, null]) {
          const args = NO_INPUT.has(name) ? [poisoned, ctx] : [poisoned, ctx, input];
          await assert.rejects(() => fn(...args), (err) => (err as { code?: string }).code === "FORBIDDEN", `${name} on ${String(channel)}`);
        }
      }
    }
  });

  test("staff channels (dashboard, api) pass the gate", async () => {
    const t = randomUUID();
    for (const channel of ["dashboard", "api"] as const) {
      const ctx = makeCtx(t, { channel });
      for (const [name, fn] of staffOps) {
        if (NO_INPUT.has(name)) continue;
        await assert.rejects(() => fn(poisoned, ctx, null), (err) => (err as { code?: string }).code === "VALIDATION_FAILED", `${name} reaches validation on ${channel}`);
      }
    }
  });

  test("a customer id cannot be probed through the gate: existing and unknown ids get the identical refusal", async () => {
    const p = await seedPair("sg-probe");
    const ctx = asChannel(p, "whatsapp", { customerId: p.alice });
    const a = await rejectsWith(call(db, ctx, engine.getCustomer, { customerId: p.bob }), "FORBIDDEN");
    const b = await rejectsWith(call(db, ctx, engine.getCustomer, { customerId: randomUUID() }), "FORBIDDEN");
    assert.deepEqual(a, b);
    await rejectsWith(call(db, ctx, searchCustomers, { query: "bob" }), "FORBIDDEN");
    await rejectsWith(call(db, ctx, createCustomer, { name: "X", phone: "+919811100002" }), "FORBIDDEN"); // would otherwise return Bob's full record as a dedupe
    await rejectsWith(call(db, ctx, listCustomerNotes, { customerId: p.bob }), "FORBIDDEN");
    await rejectsWith(call(db, ctx, listCommunications, { customerId: p.bob }), "FORBIDDEN");
    await rejectsWith(call(db, ctx, listFollowUps, {}), "FORBIDDEN");
    await rejectsWith(call(db, ctx, listResources, {}), "FORBIDDEN");
    await rejectsWith(call(db, ctx, listCatalogueItems, {}), "FORBIDDEN");
  });
});

describe("subject-bound writes a channel may make", () => {
  test("createFollowUp (escalation) needs a subject, is about the subject only, and cannot assign, schedule or relabel", async () => {
    const p = await seedPair("sg-escalate");
    const noSubject = asChannel(p, "whatsapp");
    await rejectsWith(call(db, noSubject, createFollowUp, { title: "Please call me" }), "FORBIDDEN");

    const ctx = asChannel(p, "whatsapp", { customerId: p.alice });
    await rejectsWith(call(db, ctx, createFollowUp, { title: "x", customerId: p.bob }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, createFollowUp, { title: "x", assignedUserId: randomUUID() }), "FORBIDDEN");
    await rejectsWith(call(db, ctx, createFollowUp, { title: "x", dueAt: "2031-02-01T00:00:00Z" }), "FORBIDDEN");
    await rejectsWith(call(db, ctx, createFollowUp, { title: "x", origin: "staff" }), "FORBIDDEN");
    const bobsBooking = await tx(db, p.t, (c) => insertBooking(c, p.t, { customerId: p.bob, from: at(900), to: at(960) }));
    const bobsOrder = await tx(db, p.t, (c) => insertOrder(c, p.t, { customerId: p.bob, totalPaise: 100 }));
    await rejectsWith(call(db, ctx, createFollowUp, { title: "x", bookingId: bobsBooking }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, createFollowUp, { title: "x", orderId: bobsOrder }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, createFollowUp, { title: "x", conversationId: randomUUID() }), "NOT_FOUND");

    const mine = await tx(db, p.t, (c) => insertBooking(c, p.t, { customerId: p.alice, from: at(1000), to: at(1060) }));
    const first = await call(db, ctx, createFollowUp, { title: "Call me back", bookingId: mine });
    assert.equal(first.customerId, p.alice, "customer filled in from the subject");
    assert.equal(first.origin, "ai_escalation");
    assert.equal(first.assignedUserId, null);
    assert.equal(first.dueAt, null);
    // repeats inside 30 minutes return the open task, a different customer gets their own, later ones are new (SEC-014)
    assert.equal((await call(db, ctx, createFollowUp, { title: "Call me back again" })).id, first.id);
    assert.notEqual((await call(db, asChannel(p, "whatsapp", { customerId: p.bob }), createFollowUp, { title: "Bob" })).id, first.id);
    // the window runs on the database clock: age the open task past 30 minutes
    await tx(db, p.t, (c) => c.query("update follow_up_tasks set created_at = now() - interval '31 minutes' where tenant_id = $1 and id = $2", [p.t, first.id]));
    assert.notEqual((await call(db, ctx, createFollowUp, { title: "Still waiting" })).id, first.id);
    const open = await call(db, makeCtx(p.t), listFollowUps, { customerId: p.alice });
    assert.equal(open.items.length, 2);
  });

  test("staff escalations are untouched: no dedupe, free origin and assignment", async () => {
    const p = await seedPair("sg-staff-fu");
    const staff = makeCtx(p.t);
    const a = await call(db, staff, createFollowUp, { title: "Same", customerId: p.alice, origin: "ai_escalation" });
    const b = await call(db, staff, createFollowUp, { title: "Same", customerId: p.alice, origin: "ai_escalation", dueAt: "2031-02-01T00:00:00Z" });
    assert.notEqual(a.id, b.id, "no dedupe for staff");
    assert.equal(b.dueAt, "2031-02-01T00:00:00.000Z");
  });

  test("logCommunication is bound to the subject's own customer, booking, order and conversation", async () => {
    const p = await seedPair("sg-comm");
    const body = { direction: "inbound" as const, channel: "whatsapp" as const, body: "Hello" };
    await rejectsWith(call(db, asChannel(p, "whatsapp"), logCommunication, { customerId: p.alice, ...body }), "FORBIDDEN");
    const ctx = asChannel(p, "whatsapp", { customerId: p.alice });
    await rejectsWith(call(db, ctx, logCommunication, { customerId: p.bob, ...body }), "NOT_FOUND");
    const bobsBooking = await tx(db, p.t, (c) => insertBooking(c, p.t, { customerId: p.bob, from: at(900), to: at(960) }));
    await rejectsWith(call(db, ctx, logCommunication, { customerId: p.alice, bookingId: bobsBooking, ...body }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, logCommunication, { customerId: p.alice, conversationId: randomUUID(), ...body }), "NOT_FOUND");
    const ok = await call(db, ctx, logCommunication, { customerId: p.alice, ...body });
    assert.equal(ok.customerId, p.alice);
    assert.equal((await call(db, makeCtx(p.t), listCommunications, { customerId: p.bob })).items.length, 0);
  });
});

describe("getCatalogueForChannel is strictly AI-safe", () => {
  test("only the whitelisted fields, never hidden items or internal data, on every customer channel", async () => {
    const t = await db.createTenant("sg-cat");
    const staff = makeCtx(t);
    const open = await call(db, staff, createCategory, { name: "Hair" });
    const closed = await call(db, staff, createCategory, { name: "Hidden", active: false });
    const cut = await call(db, staff, createCatalogueItem, {
      kind: "service", name: "Haircut", description: "Wash and cut", categoryId: open.id, sku: "SKU-SECRET-1", amountPaise: 50000, durationMinutes: 45, bufferMinutes: 15,
      taxRateBps: 1800, requiredResourceType: "staff", attributes: { internalNote: "margin 80%", costPaise: 1200 }, sortOrder: 1,
    });
    await call(db, staff, createVariant, { itemId: cut.id, name: "Long hair", sku: "SKU-SECRET-V", amountPaise: 70000, durationMinutes: 60 });
    const off = await call(db, staff, createVariant, { itemId: cut.id, name: "Retired variant", amountPaise: 1, active: false });
    await call(db, staff, createCatalogueItem, { kind: "service", name: "Archived thing", amountPaise: 100, durationMinutes: 10 }).then((i) => call(db, staff, engine.archiveCatalogueItem, { itemId: i.id }));
    await call(db, staff, createCatalogueItem, { kind: "product", name: "In hidden category", amountPaise: 100, categoryId: closed.id });
    await call(db, staff, createCatalogueItem, { kind: "product", name: "Sold out", amountPaise: 100, available: false });
    for (const channel of CUSTOMER_CHANNELS) {
      const r = await call(db, makeCtx(t, { channel }), getCatalogueForChannel, {});
      assert.deepEqual(r.items.map((i) => i.name), ["Sold out", "Haircut"], channel); // sortOrder 0 before 1
      const hair = r.items.find((i) => i.name === "Haircut")!;
      assert.deepEqual(Object.keys(hair).sort(), ["amountPaise", "available", "catalogueItemId", "category", "currency", "description", "durationMinutes", "kind", "name", "variants"]);
      assert.deepEqual(Object.keys(hair.variants![0]!).sort(), ["amountPaise", "durationMinutes", "name", "variantId"]);
      assert.deepEqual(hair.variants!.map((v) => v.name), ["Long hair"]);
      const wire = JSON.stringify(r);
      for (const secret of ["SKU-SECRET", "margin", "costPaise", "1800", "taxRate", "bufferMinutes", "15", "staff", "Archived", "hidden", "Retired", off.id, "sortOrder", "createdAt", "tenant", t]) {
        if (secret === "15" || secret === "staff") continue; // too generic to assert on the raw text; covered by the key checks
        assert.ok(!wire.toLowerCase().includes(String(secret).toLowerCase()), `"${secret}" must not reach a customer channel`);
      }
    }
  });

  test("search terms are literal, bounded and capped; paging is capped at 50", async () => {
    const t = await db.createTenant("sg-cat-caps");
    const staff = makeCtx(t);
    for (let i = 0; i < 3; i++) await call(db, staff, createCatalogueItem, { kind: "product", name: `Tea ${i}`, amountPaise: 100 });
    const ctx = makeCtx(t, { channel: "web_chat" });
    for (const q of ["%", "_", "\\", "T%a", "%%"]) assert.equal((await call(db, ctx, getCatalogueForChannel, { query: q })).items.length, 0, JSON.stringify(q));
    await rejectsWith(call(db, ctx, getCatalogueForChannel, { query: "x".repeat(101) }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, getCatalogueForChannel, { limit: 51 }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, getCatalogueForChannel, { limit: 0 }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, getCatalogueForChannel, { cursor: "x".repeat(513) }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, getCatalogueForChannel, { cursor: "not-a-cursor" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, getCatalogueForChannel, { tenantId: t } as never), "VALIDATION_FAILED");
  });

  test("another tenant's catalogue never appears", async () => {
    const a = await db.createTenant("sg-cat-a");
    const b = await db.createTenant("sg-cat-b");
    await call(db, makeCtx(b), createCatalogueItem, { kind: "product", name: "B only", amountPaise: 100 });
    assert.deepEqual((await call(db, makeCtx(a, { channel: "whatsapp" }), getCatalogueForChannel, {})).items, []);
  });

  test("the business profile for a channel is the whitelisted subset and works on customer channels", async () => {
    const t = await db.createTenant("sg-biz");
    const profile = await call(db, makeCtx(t, { channel: "voice" }), getBusinessProfileForChannel as never, undefined as never) as Record<string, unknown>;
    assert.deepEqual(Object.keys(profile).sort(), [
      "businessName", "cancellationPolicy", "contact", "currency", "extraQuestions", "holdMinutes", "hours", "locations", "packId", "requiredCustomerFields", "timezone",
    ]);
  });
});

describe("input caps, escaping and prototype pollution", () => {
  test("list limits are capped at 100 and search terms at their maximum length, for staff lists too", async () => {
    const t = await db.createTenant("sg-caps");
    const staff = makeCtx(t);
    await rejectsWith(call(db, staff, searchCustomers, { limit: 101 }), "VALIDATION_FAILED");
    await rejectsWith(call(db, staff, searchCustomers, { query: "x".repeat(121) }), "VALIDATION_FAILED");
    await rejectsWith(call(db, staff, searchCustomers, { cursor: "y".repeat(513) }), "VALIDATION_FAILED");
    await rejectsWith(call(db, staff, listCatalogueItems, { limit: 101 }), "VALIDATION_FAILED");
    await rejectsWith(call(db, staff, listCatalogueItems, { query: "x".repeat(101) }), "VALIDATION_FAILED");
    await rejectsWith(call(db, staff, listResources, { limit: 101 }), "VALIDATION_FAILED");
    await rejectsWith(call(db, staff, listFollowUps, { limit: 101 }), "VALIDATION_FAILED");
    await rejectsWith(call(db, staff, listResources, { query: "x".repeat(101) }), "VALIDATION_FAILED");
  });

  test("LIKE metacharacters are literal in every staff search", async () => {
    const t = await db.createTenant("sg-like-staff");
    const staff = makeCtx(t);
    await call(db, staff, createCustomer, { name: "Plain Name", email: "plain@example.com" });
    await call(db, staff, createCustomer, { name: "100% Real_Deal" });
    await call(db, staff, createCatalogueItem, { kind: "product", name: "Plain", amountPaise: 1 });
    await call(db, staff, createResource, { type: "staff", name: "Plain Staff" });
    for (const q of ["%", "_", "%%", "\\", "P%n", "P_ain"]) {
      assert.equal((await call(db, staff, listCatalogueItems, { query: q })).items.length, 0, `catalogue ${q}`);
      assert.equal((await call(db, staff, listResources, { query: q })).items.length, 0, `resources ${q}`);
    }
    assert.equal((await call(db, staff, searchCustomers, { query: "%" })).items.length, 1, "only the name that really contains %");
    assert.equal((await call(db, staff, searchCustomers, { query: "_" })).items.length, 1, "only the name that really contains _");
    assert.equal((await call(db, staff, searchCustomers, { query: "P%n" })).items.length, 0);
  });

  test("attribute keys cannot reach Object.prototype and `__proto__` is refused everywhere attributes are accepted", async () => {
    const t = await db.createTenant("sg-proto");
    const staff = makeCtx(t);
    const evil = JSON.parse('{"__proto__": {"polluted": "yes"}}') as Record<string, unknown>;
    const evilScalar = JSON.parse('{"__proto__": "yes"}') as Record<string, unknown>;
    const customer = (await call(db, staff, createCustomer, { name: "P" })).customer;
    const item = await call(db, staff, createCatalogueItem, { kind: "product", name: "P", amountPaise: 1 });
    const resource = await call(db, staff, createResource, { type: "staff", name: "P" });
    // `__proto__` as an own key (what JSON.parse produces) is dropped by the schema: never stored, never merged into a prototype
    for (const attributes of [evil, evilScalar]) {
      const c = (await call(db, staff, createCustomer, { name: "Q", attributes } as never)).customer;
      assert.deepEqual(c.attributes, {});
      assert.equal(Object.getPrototypeOf(c.attributes), Object.prototype);
      const r = await call(db, staff, updateResource, { resourceId: resource.id, attributes } as never);
      assert.deepEqual(r.attributes, {});
      const raw = await tx(db, t, async (cl) => (await cl.query<{ a: string }>("select attributes::text as a from customers where tenant_id = $1 and id = $2", [t, c.id])).rows[0]!.a);
      assert.ok(!raw.includes("__proto__") && !raw.includes("polluted"), raw);
    }
    // everything else that is not a plain key with a scalar value is refused
    for (const attributes of [{ constructor: { prototype: { polluted: "yes" } } }, { "prototype.polluted": "yes" }, { polluted: { nested: 1 } }, { _private: "x" }]) {
      await rejectsWith(call(db, staff, createCustomer, { name: "Q", attributes } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, staff, engine.updateCustomer, { customerId: customer.id, attributes } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, staff, createCatalogueItem, { kind: "product", name: "Q", amountPaise: 1, attributes } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, staff, engine.updateCatalogueItem, { itemId: item.id, attributes } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, staff, createResource, { type: "staff", name: "Q", attributes } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, staff, updateResource, { resourceId: resource.id, attributes } as never), "VALIDATION_FAILED");
    }
    // plain words that merely look dangerous are ordinary keys with scalar values, stored as data
    const ok = await call(db, staff, updateResource, { resourceId: resource.id, attributes: { constructor: "x", toString: "y", hasOwnProperty: "z" } });
    assert.deepEqual(Object.keys(ok.attributes).sort(), ["constructor", "hasOwnProperty", "toString"]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
    assert.equal(typeof ({} as Record<string, unknown>).toString, "function", "Object.prototype itself is intact");
  });

  test("database constraint names never reach the caller (SEC-022)", () => {
    for (const code of ["23505", "23503", "23514", "23P01"]) {
      const err = Object.assign(new Error("secret db text"), { code, constraint: "customers_pkey_internal_name" });
      const mapped = mapPgError(err) as { details: Record<string, unknown>; message: string };
      assert.ok(!("constraint" in mapped.details), `${code} details`);
      assert.ok(!JSON.stringify(mapped).includes("customers_pkey_internal_name"), `${code} wire`);
    }
  });

  test("category and variant management are staff-only", async () => {
    const t = await db.createTenant("sg-mgmt");
    const web = makeCtx(t, { channel: "web_chat" });
    for (const [fn, input] of [
      [createCategory, { name: "x" }], [updateCategory, { categoryId: randomUUID(), name: "x" }], [createVariant, { itemId: randomUUID(), name: "x", amountPaise: 1 }],
      [updateVariant, { variantId: randomUUID(), name: "x" }], [createCatalogueItem, { kind: "product", name: "x", amountPaise: 1 }],
    ] as const) await rejectsWith(call(db, web, fn as never, input as never), "FORBIDDEN");
  });
});
