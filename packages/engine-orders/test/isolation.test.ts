// Tenant isolation for every engine function, smuggled tenant ids, cross-tenant references, and the AI-safe status view.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { AppError, toErrorBody } from "@qenbel/shared";
import {
  acceptOrder,
  addItem,
  applyDiscount,
  cancelOrder,
  createOrderDraft,
  fulfil,
  getOrder,
  getOrderBoard,
  getOrderStatusForChannel,
  listOrders,
  listPayments,
  markReady,
  placeOrder,
  recordPayment,
  recordRefund,
  rejectOrder,
  removeDiscount,
  removeItem,
  setFulfilment,
  startProcessing,
  transitionOrder,
  updateItem,
  updateOrderNotes,
  type OrderView,
} from "../src/index.ts";
import { connect, ctxFor, insert, rejectsWith, restaurantFixture, tx, type Client, type Fixture, type TestDb } from "./helpers.ts";

let db: TestDb;
let a: Fixture;
let b: Fixture;
let orderA: OrderView;

before(async () => {
  db = await connect();
  a = await restaurantFixture(db);
  b = await restaurantFixture(db);
  orderA = await tx(db, a.tenantId, async (s) => {
    const d = await createOrderDraft(s, ctxFor(a.tenantId), { items: [{ catalogueItemId: a.tikka, quantity: 2 }], customerId: a.customerId, notes: "gate code 4417" });
    const p = await placeOrder(s, ctxFor(a.tenantId), { orderId: d.id });
    await recordPayment(s, ctxFor(a.tenantId), { orderId: p.id, amountPaise: 1000, method: "cash" });
    return getOrder(s, ctxFor(a.tenantId), { orderId: p.id });
  });
});
after(async () => {
  await db.close();
});

const inB = <T>(fn: (s: Client, ctx: ReturnType<typeof ctxFor>) => Promise<T>) => tx(db, b.tenantId, (s) => fn(s, ctxFor(b.tenantId)));

// Every function that takes an order id, called as tenant B with tenant A's order id.
const orderCalls: [string, (s: Client, c: ReturnType<typeof ctxFor>, id: string, v: number) => Promise<unknown>][] = [
  ["getOrder", (s, c, id) => getOrder(s, c, { orderId: id })],
  ["addItem", (s, c, id, v) => addItem(s, c, { orderId: id, expectedVersion: v, item: { catalogueItemId: b.tikka, quantity: 1 } })],
  ["updateItem", (s, c, id, v) => updateItem(s, c, { orderId: id, expectedVersion: v, itemId: randomUUID(), quantity: 1 })],
  ["removeItem", (s, c, id, v) => removeItem(s, c, { orderId: id, expectedVersion: v, itemId: randomUUID() })],
  ["updateOrderNotes", (s, c, id, v) => updateOrderNotes(s, c, { orderId: id, expectedVersion: v, notes: "x" })],
  ["applyDiscount", (s, c, id, v) => applyDiscount(s, c, { orderId: id, expectedVersion: v, kind: "fixed", amountPaise: 1 })],
  ["removeDiscount", (s, c, id, v) => removeDiscount(s, c, { orderId: id, expectedVersion: v })],
  ["setFulfilment", (s, c, id, v) => setFulfilment(s, c, { orderId: id, expectedVersion: v, fulfilment: { type: "pickup" } })],
  ["placeOrder", (s, c, id, v) => placeOrder(s, c, { orderId: id, expectedVersion: v, customerId: b.customerId })],
  ["acceptOrder", (s, c, id, v) => acceptOrder(s, c, { orderId: id, expectedVersion: v })],
  ["startProcessing", (s, c, id, v) => startProcessing(s, c, { orderId: id, expectedVersion: v })],
  ["markReady", (s, c, id, v) => markReady(s, c, { orderId: id, expectedVersion: v })],
  ["fulfil", (s, c, id, v) => fulfil(s, c, { orderId: id, expectedVersion: v })],
  ["rejectOrder", (s, c, id, v) => rejectOrder(s, c, { orderId: id, expectedVersion: v })],
  ["cancelOrder", (s, c, id, v) => cancelOrder(s, c, { orderId: id, expectedVersion: v })],
  ["transitionOrder", (s, c, id, v) => transitionOrder(s, c, { orderId: id, to: "ACCEPTED", expectedVersion: v })],
  ["recordPayment", (s, c, id) => recordPayment(s, c, { orderId: id, amountPaise: 100, method: "cash" })],
  ["recordRefund", (s, c, id) => recordRefund(s, c, { orderId: id, amountPaise: 100, method: "cash" })],
  ["listPayments", (s, c, id) => listPayments(s, c, { orderId: id })],
  ["getOrderStatusForChannel (by id)", (s, c, id) => getOrderStatusForChannel(s, c, { customerId: b.customerId, orderId: id })],
];

describe("tenant B cannot touch tenant A's order through any function", () => {
  for (const [name, fn] of orderCalls) {
    it(`${name}: NOT_FOUND`, async () => {
      await rejectsWith(() => inB((s, c) => fn(s, c, orderA.id, orderA.version)), "NOT_FOUND");
    });
  }

  it("and A's order is untouched afterwards", async () => {
    const now = await tx(db, a.tenantId, (s) => getOrder(s, ctxFor(a.tenantId), { orderId: orderA.id }));
    assert.equal(now.version, orderA.version);
    assert.equal(now.status, "PLACED");
    assert.equal(now.payment.paidPaise, 1000);
    assert.equal(now.items.length, 1);
  });

  it("B's lists and board never contain A's orders", async () => {
    const list = await inB((s, c) => listOrders(s, c, { limit: 100 }));
    assert.ok(!list.items.some((i) => i.id === orderA.id));
    const board = await inB((s, c) => getOrderBoard(s, c));
    assert.ok(board.every((col) => col.count === 0 && col.orders.length === 0));
    const byCustomer = await inB((s, c) => listOrders(s, c, { customerId: a.customerId }));
    assert.equal(byCustomer.items.length, 0);
  });

  it("B cannot read A's outbox events or audit rows", async () => {
    const ev = await inB((s) => s.query("select count(*)::int as n from outbox_events where aggregate_id = $1", [orderA.id]));
    assert.equal(ev.rows[0]?.n, 0);
    const audit = await inB((s) => s.query("select count(*)::int as n from audit_log where entity_id = $1", [orderA.id]));
    assert.equal(audit.rows[0]?.n, 0);
  });
});

describe("ctx tenant must match the database session", () => {
  const cases: [string, (s: Client, c: ReturnType<typeof ctxFor>) => Promise<unknown>][] = [
    ["createOrderDraft", (s, c) => createOrderDraft(s, c, { items: [{ catalogueItemId: b.tikka, quantity: 1 }] })],
    ["getOrder", (s, c) => getOrder(s, c, { orderId: orderA.id })],
    ["listOrders", (s, c) => listOrders(s, c, {})],
    ["getOrderBoard", (s, c) => getOrderBoard(s, c, {})],
    ["recordPayment", (s, c) => recordPayment(s, c, { orderId: orderA.id, amountPaise: 1, method: "cash" })],
    ["cancelOrder", (s, c) => cancelOrder(s, c, { orderId: orderA.id })],
  ];
  for (const [name, fn] of cases) {
    it(`${name}: ctx says A, session is B -> TENANT_REQUIRED, nothing written`, async () => {
      await rejectsWith(() => tx(db, b.tenantId, (s) => fn(s, ctxFor(a.tenantId))), "TENANT_REQUIRED");
    });
  }

  it("a client that never ran withTenant is refused", async () => {
    const client = await db.app.connect();
    try {
      await rejectsWith(() => getOrder(client, ctxFor(a.tenantId), { orderId: orderA.id }), "TENANT_REQUIRED");
      await rejectsWith(() => createOrderDraft(client, ctxFor(a.tenantId), { items: [{ catalogueItemId: a.tikka, quantity: 1 }] }), "TENANT_REQUIRED");
    } finally {
      client.release();
    }
  });

  it("a malformed ctx tenant id is refused", async () => {
    await rejectsWith(() => tx(db, a.tenantId, (s) => getOrder(s, ctxFor("not-a-uuid"), { orderId: orderA.id })), "TENANT_REQUIRED");
    await rejectsWith(() => tx(db, a.tenantId, (s) => getOrder(s, ctxFor("' or 1=1 --"), { orderId: orderA.id })), "TENANT_REQUIRED");
  });
});

describe("a tenant id (or role) smuggled in any input is rejected", () => {
  const withTenantField = (base: Record<string, unknown>) => ({ ...base, tenantId: b.tenantId });
  const id = () => randomUUID();
  const cases: [string, (s: Client, c: ReturnType<typeof ctxFor>) => Promise<unknown>][] = [
    ["createOrderDraft", (s, c) => createOrderDraft(s, c, withTenantField({ items: [{ catalogueItemId: b.tikka, quantity: 1 }] }) as never)],
    ["addItem", (s, c) => addItem(s, c, withTenantField({ orderId: id(), expectedVersion: 1, item: { catalogueItemId: b.tikka, quantity: 1 } }) as never)],
    ["updateItem", (s, c) => updateItem(s, c, withTenantField({ orderId: id(), expectedVersion: 1, itemId: id(), quantity: 1 }) as never)],
    ["removeItem", (s, c) => removeItem(s, c, withTenantField({ orderId: id(), expectedVersion: 1, itemId: id() }) as never)],
    ["applyDiscount", (s, c) => applyDiscount(s, c, withTenantField({ orderId: id(), expectedVersion: 1, kind: "fixed", amountPaise: 1 }) as never)],
    ["setFulfilment", (s, c) => setFulfilment(s, c, withTenantField({ orderId: id(), expectedVersion: 1, fulfilment: { type: "pickup" } }) as never)],
    ["placeOrder", (s, c) => placeOrder(s, c, withTenantField({ orderId: id() }) as never)],
    ["acceptOrder", (s, c) => acceptOrder(s, c, withTenantField({ orderId: id(), expectedVersion: 1 }) as never)],
    ["cancelOrder", (s, c) => cancelOrder(s, c, withTenantField({ orderId: id() }) as never)],
    ["transitionOrder", (s, c) => transitionOrder(s, c, withTenantField({ orderId: id(), to: "ACCEPTED", expectedVersion: 1 }) as never)],
    ["recordPayment", (s, c) => recordPayment(s, c, withTenantField({ orderId: id(), amountPaise: 1, method: "cash" }) as never)],
    ["recordRefund", (s, c) => recordRefund(s, c, withTenantField({ orderId: id(), amountPaise: 1, method: "cash" }) as never)],
    ["getOrder", (s, c) => getOrder(s, c, withTenantField({ orderId: id() }) as never)],
    ["listOrders", (s, c) => listOrders(s, c, withTenantField({}) as never)],
    ["getOrderStatusForChannel", (s, c) => getOrderStatusForChannel(s, c, withTenantField({ customerId: b.customerId, orderId: id() }) as never)],
  ];
  for (const [name, fn] of cases) {
    it(`${name}: tenantId in the input is VALIDATION_FAILED`, async () => {
      await rejectsWith(() => inB((s, c) => fn(s, c)), "VALIDATION_FAILED");
    });
  }

  it("so are tenant_id, orgId and role spellings", async () => {
    for (const key of ["tenant_id", "orgId", "org_id", "role", "permissions", "actor"]) {
      await rejectsWith(() => inB((s, c) => getOrder(s, c, { orderId: randomUUID(), [key]: "x" } as never)), "VALIDATION_FAILED");
    }
  });
});

describe("cross-tenant references are rejected", () => {
  it("B cannot order A's catalogue item, variant, customer, booking or table", async () => {
    await rejectsWith(() => inB((s, c) => createOrderDraft(s, c, { items: [{ catalogueItemId: a.tikka, quantity: 1 }] })), "NOT_FOUND", "CATALOGUE_ITEM_NOT_FOUND");
    await rejectsWith(() => inB((s, c) => createOrderDraft(s, c, { items: [{ catalogueItemId: b.biryani, variantId: a.variants.half, quantity: 1 }] })), "NOT_FOUND", "CATALOGUE_VARIANT_NOT_FOUND");
    await rejectsWith(() => inB((s, c) => createOrderDraft(s, c, { items: [{ catalogueItemId: b.tikka, quantity: 1 }], customerId: a.customerId })), "NOT_FOUND", "CUSTOMER_NOT_FOUND");
    await rejectsWith(() => inB((s, c) => createOrderDraft(s, c, { items: [{ catalogueItemId: b.tikka, quantity: 1 }], resourceId: a.tableId })), "NOT_FOUND", "RESOURCE_NOT_FOUND");
    const bookingA = await tx(db, a.tenantId, (s) =>
      insert(s, "bookings", { tenant_id: a.tenantId, location_id: a.locationId, customer_id: a.customerId, status: "CONFIRMED", source_channel: "api", starts_at: new Date("2031-04-01T10:00:00Z"), ends_at: new Date("2031-04-01T11:00:00Z") }),
    );
    await rejectsWith(() => inB((s, c) => createOrderDraft(s, c, { items: [{ catalogueItemId: b.tikka, quantity: 1 }], bookingId: bookingA })), "NOT_FOUND", "BOOKING_NOT_FOUND");
  });

  it("an item added to B's draft cannot be A's; placing cannot attach A's customer", async () => {
    const d = await inB((s, c) => createOrderDraft(s, c, { items: [{ catalogueItemId: b.tikka, quantity: 1 }] }));
    await rejectsWith(() => inB((s, c) => addItem(s, c, { orderId: d.id, expectedVersion: 1, item: { catalogueItemId: a.soda, quantity: 1 } })), "NOT_FOUND", "CATALOGUE_ITEM_NOT_FOUND");
    await rejectsWith(() => inB((s, c) => placeOrder(s, c, { orderId: d.id, customerId: a.customerId })), "NOT_FOUND", "CUSTOMER_NOT_FOUND");
    await rejectsWith(() => inB((s, c) => setFulfilment(s, c, { orderId: d.id, expectedVersion: 1, fulfilment: { type: "dine_in", resourceId: a.tableId } })), "NOT_FOUND", "RESOURCE_NOT_FOUND");
    const untouched = await inB((s, c) => getOrder(s, c, { orderId: d.id }));
    assert.equal(untouched.version, 1);
    assert.equal(untouched.items.length, 1);
  });

  it("an inline customer on confirm is looked up only inside the tenant", async () => {
    const phone = `+9199${String(Date.now()).slice(-8)}`;
    const inA = await tx(db, a.tenantId, (s) => insert(s, "customers", { tenant_id: a.tenantId, name: "Only In A", phone }));
    const d = await inB((s, c) => createOrderDraft(s, c, { items: [{ catalogueItemId: b.tikka, quantity: 1 }] }));
    const placed = await inB((s, c) => placeOrder(s, c, { orderId: d.id, customer: { name: "Newcomer", phone } }));
    assert.notEqual(placed.customerId, inA, "A's customer is never reused in B");
    const inBRow = await inB((s) => s.query("select name from customers where id = $1", [placed.customerId]));
    assert.equal(inBRow.rows[0]?.name, "Newcomer");
    const aRow = await tx(db, a.tenantId, (s) => s.query("select count(*)::int as n from customers where phone = $1", [phone]));
    assert.equal(aRow.rows[0]?.n, 1, "A still has exactly its own");
    const bSees = await inB((s) => s.query("select count(*)::int as n from customers where id = $1", [inA]));
    assert.equal(bSees.rows[0]?.n, 0);
  });

  it("at the database too: a direct write of B's order pointing at A's customer is refused by the composite key", async () => {
    await assert.rejects(
      tx(db, b.tenantId, (s) =>
        insert(s, "orders", { tenant_id: b.tenantId, customer_id: a.customerId, source_channel: "api" }),
      ),
      (e: { code?: string }) => e.code === "23503",
    );
  });
});

describe("getOrderStatusForChannel: minimal fields, only for the owning customer", () => {
  let mine: OrderView;
  let theirs: OrderView;
  let anonymous: OrderView;

  before(async () => {
    const run = <T>(fn: (s: Client) => Promise<T>) => tx(db, a.tenantId, fn);
    const c = () => ctxFor(a.tenantId, { channel: "whatsapp" });
    mine = await run(async (s) => {
      const d = await createOrderDraft(s, c(), { items: [{ catalogueItemId: a.tikka, quantity: 2, note: "extra spicy" }, { catalogueItemId: a.soda, quantity: 1 }], customerId: a.customerId, notes: "door code 9921, call me on 9811100001" });
      return placeOrder(s, c(), { orderId: d.id });
    });
    theirs = await run(async (s) => {
      const d = await createOrderDraft(s, c(), { items: [{ catalogueItemId: a.papad, quantity: 1 }], customerId: a.otherCustomerId, notes: "other customer's note" });
      return placeOrder(s, c(), { orderId: d.id });
    });
    anonymous = await run((s) => createOrderDraft(s, c(), { items: [{ catalogueItemId: a.papad, quantity: 3 }] }));
  });

  const status = (input: Record<string, unknown>) => tx(db, a.tenantId, (s) => getOrderStatusForChannel(s, ctxFor(a.tenantId, { channel: "whatsapp" }), input as never));

  it("returns exactly the safe fields for the owner, by id and by reference (any case)", async () => {
    const byId = await status({ customerId: a.customerId, orderId: mine.id });
    const byRef = await status({ customerId: a.customerId, orderReference: mine.reference.toLowerCase() });
    assert.deepEqual(byId, byRef);
    assert.deepEqual(Object.keys(byId).sort(), ["currency", "lines", "orderId", "paymentStatus", "reference", "status", "statusLabel", "totalAmountPaise", "updatedAt", "version"]);
    assert.equal(byId.status, "PLACED");
    assert.equal(byId.statusLabel, "New");
    assert.equal(byId.totalAmountPaise, mine.totalPaise);
    assert.deepEqual(byId.lines.map((l) => [l.name, l.quantity, l.unitAmountPaise, l.lineAmountPaise, l.notes]), [
      ["Paneer tikka", 2, 10000, 20000, "extra spicy"],
      ["Lime soda", 1, 4950, 4950, undefined],
    ]);
    const text = JSON.stringify(byId);
    for (const secret of ["door code", "9921", "9811100001", "Asha", "asha@example.com", a.customerId, "other customer"]) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
  });

  it("another customer of the same business gets NOT_FOUND, identical to a missing order", async () => {
    const stranger = (input: Record<string, unknown>) => status({ customerId: a.otherCustomerId, ...input }).then(() => assert.fail("should not return"), (e: unknown) => e as AppError);
    const foreignById = await stranger({ orderId: mine.id });
    const foreignByRef = await stranger({ orderReference: mine.reference });
    const missingById = await stranger({ orderId: randomUUID() });
    const missingByRef = await stranger({ orderReference: "ZZZZZZZZ" });
    for (const e of [foreignById, foreignByRef, missingById, missingByRef]) {
      assert.equal(e.code, "NOT_FOUND");
      assert.deepEqual(toErrorBody(e), toErrorBody(foreignById), "same body: no oracle for 'exists but not yours'");
    }
  });

  it("their own order is visible to them and only to them", async () => {
    const own = await status({ customerId: a.otherCustomerId, orderId: theirs.id });
    assert.equal(own.orderId, theirs.id);
    await rejectsWith(() => status({ customerId: a.customerId, orderId: theirs.id }), "NOT_FOUND");
  });

  it("an order with no customer is visible to nobody; an unknown or foreign-tenant customer sees nothing", async () => {
    await rejectsWith(() => status({ customerId: a.customerId, orderId: anonymous.id }), "NOT_FOUND");
    await rejectsWith(() => status({ customerId: randomUUID(), orderId: mine.id }), "NOT_FOUND");
    await rejectsWith(() => status({ customerId: b.customerId, orderId: mine.id }), "NOT_FOUND");
    await rejectsWith(() => status({ customerId: b.customerId, orderReference: mine.reference }), "NOT_FOUND");
  });

  it("references match exactly: a prefix or wildcard finds nothing", async () => {
    await rejectsWith(() => status({ customerId: a.customerId, orderReference: mine.reference.slice(0, 5) }), "NOT_FOUND");
    await rejectsWith(() => status({ customerId: a.customerId, orderReference: "%%%" }), "NOT_FOUND");
    await rejectsWith(() => status({ customerId: a.customerId, orderReference: "' or '1'='1" }), "NOT_FOUND");
  });

  it("needs exactly one of orderId and orderReference, and a customer", async () => {
    await rejectsWith(() => status({ customerId: a.customerId }), "VALIDATION_FAILED");
    await rejectsWith(() => status({ customerId: a.customerId, orderId: mine.id, orderReference: mine.reference }), "VALIDATION_FAILED");
    await rejectsWith(() => status({ orderId: mine.id }), "VALIDATION_FAILED");
    await rejectsWith(() => status({ customerId: a.customerId, orderId: mine.id, includeNotes: true }), "VALIDATION_FAILED");
  });

  it("follows the order: status label updates, and a cancelled order still reports honestly", async () => {
    await tx(db, a.tenantId, (s) => acceptOrder(s, ctxFor(a.tenantId), { orderId: mine.id, expectedVersion: mine.version }));
    const s1 = await status({ customerId: a.customerId, orderId: mine.id });
    assert.equal(s1.status, "ACCEPTED");
    assert.equal(s1.version, mine.version + 1);
    await tx(db, a.tenantId, (s) => cancelOrder(s, ctxFor(a.tenantId), { orderId: mine.id, onBehalfOfCustomerId: a.customerId }));
    assert.equal((await status({ customerId: a.customerId, orderId: mine.id })).status, "CANCELLED");
  });
});
