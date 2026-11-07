// Lifecycle against the real Postgres: the full transition matrix, pack narrowing, optimistic version conflicts under
// concurrency, placement rules, outbox events (once, and only on commit) and audit rows.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { DEFAULT_ORDER_TRANSITIONS, OrderStatus, orderMachine, canTransition, type ConfigPack } from "@qenbel/shared";
import { getPack as registryPack } from "@qenbel/config-packs";
import { withTenant } from "@qenbel/db";
import {
  acceptOrder,
  addItem,
  applyDiscount,
  cancelOrder,
  createOrderDraft,
  fulfil,
  getOrder,
  machineForPack,
  markReady,
  placeOrder,
  recordPayment,
  rejectOrder,
  removeItem,
  setFulfilment,
  setPackResolver,
  startProcessing,
  transitionOrder,
  updateItem,
  type OrderView,
} from "../src/index.ts";
import { connect, count, ctxFor, insert, rejectsWith, restaurantFixture, tx, type Client, type Fixture, type TestDb } from "./helpers.ts";

let db: TestDb;
let fx: Fixture;

before(async () => {
  db = await connect();
  fx = await restaurantFixture(db);
});
after(async () => {
  setPackResolver(null);
  await db.close();
});

const ctx = (extra = {}) => ctxFor(fx.tenantId, extra);
const call = <T>(fn: (c: Client) => Promise<T>) => tx(db, fx.tenantId, fn);

async function newDraft(customerId: string | null = fx.customerId): Promise<OrderView> {
  return call((s) =>
    createOrderDraft(s, ctx(), {
      items: [{ catalogueItemId: fx.tikka, quantity: 2 }, { catalogueItemId: fx.soda, quantity: 1 }],
      ...(customerId ? { customerId } : {}),
    }),
  );
}
const place = (o: OrderView) => call((s) => placeOrder(s, ctx(), { orderId: o.id, expectedVersion: o.version }));
const step = (fn: typeof acceptOrder, o: OrderView) => call((s) => fn(s, ctx(), { orderId: o.id, expectedVersion: o.version }));

async function events(orderId: string): Promise<{ type: string; payload: Record<string, unknown>; event_id: string }[]> {
  const res = await call((s) =>
    s.query<{ type: string; payload: Record<string, unknown>; event_id: string }>(
      "select type, payload, event_id from outbox_events where tenant_id = $1 and (aggregate_id = $2 or payload->>'orderId' = $2::text) order by created_at, id",
      [fx.tenantId, orderId],
    ),
  );
  return res.rows;
}

describe("happy path", () => {
  it("DRAFT -> PLACED -> ACCEPTED -> PROCESSING -> READY -> FULFILLED with versions, labels, events and audit", async () => {
    let o = await newDraft();
    assert.equal(o.version, 1);
    o = await place(o);
    assert.equal([o.status, o.version, o.statusLabel].join("/"), "PLACED/2/New");
    assert.ok(o.placedAt);
    o = await step(acceptOrder, o);
    assert.equal([o.status, o.version, o.statusLabel].join("/"), "ACCEPTED/3/Accepted");
    o = await step(startProcessing, o);
    assert.equal([o.status, o.version, o.statusLabel].join("/"), "PROCESSING/4/Preparing");
    o = await step(markReady, o);
    assert.equal([o.status, o.version, o.statusLabel].join("/"), "READY/5/Ready");
    o = await step(fulfil, o);
    assert.equal([o.status, o.version, o.statusLabel].join("/"), "FULFILLED/6/Served");
    assert.ok(o.fulfilledAt);
    assert.deepEqual(o.allowedNext, ["REFUNDED"]);

    const ev = await events(o.id);
    assert.deepEqual(ev.map((e) => e.type), ["order.created", "order.accepted", "order.fulfilled"], "PROCESSING and READY send nothing");
    assert.equal(new Set(ev.map((e) => e.event_id)).size, 3);
    const created = ev[0]!.payload;
    assert.equal(created.orderId, o.id);
    assert.equal(created.status, "PLACED");
    assert.equal(created.totalPaise, o.totalPaise);
    assert.equal(created.customerId, fx.customerId);
    assert.deepEqual(Object.keys(created).sort(), ["currency", "customerId", "occurredAt", "orderId", "paymentStatus", "previousStatus", "reference", "source", "status", "totalPaise", "version"]);
    assert.ok(!JSON.stringify(created).includes("Asha"), "no personal details in events");
    assert.ok(!JSON.stringify(created).includes("+9198"));

    const audit = await call((s) => s.query<{ action: string; actor_id: string }>("select action, actor_id from audit_log where tenant_id = $1 and entity_id = $2 order by seq", [fx.tenantId, o.id]));
    assert.deepEqual(audit.rows.map((r) => r.action), ["order.draft_created", "order.placed", "order.accepted", "order.processing", "order.ready", "order.fulfilled"]);
    assert.equal(audit.rows[0]?.actor_id, "00000000-0000-0000-0000-0000000000aa");
  });

  it("fulfilment row follows the order (in progress, completed)", async () => {
    let o = await call((s) => createOrderDraft(s, ctx(), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }], customerId: fx.customerId, resourceId: fx.tableId }));
    o = await place(o);
    o = await step(acceptOrder, o);
    o = await step(startProcessing, o);
    assert.equal((await call((s) => getOrder(s, ctx(), { orderId: o.id }))).fulfilment?.status, "in_progress");
    o = await step(markReady, o);
    o = await step(fulfil, o);
    assert.equal(o.fulfilment?.status, "completed");
    assert.ok(o.fulfilment?.completedAt);
  });
});

describe("transition matrix (default restaurant machine)", () => {
  const ALL = Object.values(OrderStatus);

  /** An order forced into `status` with a customer, items, and (for FULFILLED -> REFUNDED) a fully refunded ledger. */
  async function orderAt(status: OrderStatus, fullyRefunded: boolean): Promise<OrderView> {
    const d = await newDraft();
    await call(async (s) => {
      await s.query("update orders set status = $3 where tenant_id = $1 and id = $2", [fx.tenantId, d.id, status]);
      if (fullyRefunded) {
        for (const kind of ["payment", "refund"]) {
          await insert(s, "payments", { tenant_id: fx.tenantId, order_id: d.id, kind, method: "cash", amount_paise: d.totalPaise });
        }
      }
    });
    return call((s) => getOrder(s, ctx(), { orderId: d.id }));
  }

  for (const from of ALL) {
    for (const to of ALL) {
      const legal = canTransition(orderMachine, from, to);
      it(`${from} -> ${to} is ${legal ? "allowed" : "refused"}`, async () => {
        const o = await orderAt(from, from === "FULFILLED" && to === "REFUNDED");
        const attempt = call((s) => transitionOrder(s, ctx(), { orderId: o.id, to, expectedVersion: o.version }));
        if (legal) {
          const r = await attempt;
          assert.equal(r.status, to);
          assert.equal(r.version, o.version + 1);
        } else {
          const e = await rejectsWith(() => attempt, "INVALID_TRANSITION", undefined);
          assert.equal(e.details.from, from);
          assert.equal(e.details.to, to);
          const same = await call((s) => getOrder(s, ctx(), { orderId: o.id }));
          assert.equal(same.status, from, "status unchanged");
          assert.equal(same.version, o.version, "version unchanged");
          assert.equal((await events(o.id)).length, 0, "no event for a refused move");
        }
      });
    }
  }

  it("the matrix covers exactly the default machine's edges", () => {
    const edges = Object.values(DEFAULT_ORDER_TRANSITIONS).reduce((n, t) => n + t.length, 0);
    assert.equal(edges, 10); // DRAFT 2, PLACED 3, ACCEPTED 2, PROCESSING 1, READY 1, FULFILLED 1
  });

  it("named steps refuse the wrong starting status", async () => {
    const draft = await newDraft();
    await rejectsWith(() => step(acceptOrder, draft), "INVALID_TRANSITION");
    await rejectsWith(() => step(startProcessing, draft), "INVALID_TRANSITION");
    await rejectsWith(() => step(markReady, draft), "INVALID_TRANSITION");
    await rejectsWith(() => step(fulfil, draft), "INVALID_TRANSITION");
    await rejectsWith(() => call((s) => rejectOrder(s, ctx(), { orderId: draft.id, expectedVersion: draft.version })), "INVALID_TRANSITION");
    const placed = await place(draft);
    await rejectsWith(() => step(markReady, placed), "INVALID_TRANSITION");
    const accepted = await step(acceptOrder, placed);
    await rejectsWith(() => call((s) => rejectOrder(s, ctx(), { orderId: accepted.id, expectedVersion: accepted.version })), "INVALID_TRANSITION");
    const processing = await step(startProcessing, accepted);
    await rejectsWith(() => call((s) => cancelOrder(s, ctx(), { orderId: processing.id, expectedVersion: processing.version })), "INVALID_TRANSITION");
  });

  it("terminal orders accept nothing", async () => {
    const o = await place(await newDraft());
    const c = await call((s) => cancelOrder(s, ctx(), { orderId: o.id, expectedVersion: o.version, reason: "changed mind" }));
    assert.equal(c.status, "CANCELLED");
    assert.equal(c.cancellationReason, "changed mind");
    assert.ok(c.cancelledAt);
    assert.deepEqual(c.allowedNext, []);
    for (const fn of [acceptOrder, startProcessing, markReady, fulfil]) await rejectsWith(() => step(fn, c), "INVALID_TRANSITION");
    await rejectsWith(() => call((s) => cancelOrder(s, ctx(), { orderId: c.id })), "INVALID_TRANSITION");
  });
});

describe("pack narrowing", () => {
  it("machineForPack follows the pack, not the default", () => {
    const base = registryPack("restaurant");
    const narrowed: ConfigPack = {
      ...base,
      orderTransitions: {
        ...base.orderTransitions,
        transitions: { ...base.orderTransitions.transitions, PLACED: ["ACCEPTED", "CANCELLED"], ACCEPTED: ["PROCESSING"] },
      },
    };
    const m = machineForPack(narrowed);
    assert.ok(canTransition(m, "PLACED", "ACCEPTED"));
    assert.ok(!canTransition(m, "PLACED", "REJECTED"));
    assert.ok(!canTransition(m, "ACCEPTED", "CANCELLED"));
    assert.ok(canTransition(machineForPack(base), "PLACED", "REJECTED"));
    assert.equal(machineForPack(null), orderMachine);
  });

  it("the engine refuses an edge the tenant's pack removed, and uses the pack's labels", async () => {
    const base = registryPack("restaurant");
    const narrowed: ConfigPack = {
      ...base,
      orderTransitions: {
        labels: { ...base.orderTransitions.labels, PLACED: "Incoming" },
        transitions: { ...base.orderTransitions.transitions, PLACED: ["ACCEPTED", "CANCELLED"], ACCEPTED: ["PROCESSING"] },
      },
    };
    setPackResolver((id) => (id === "restaurant-narrow" ? narrowed : registryPack(id)));
    try {
      const n = await restaurantFixture(db, "restaurant-narrow");
      const c = ctxFor(n.tenantId);
      const run = <T>(fn: (s: Client) => Promise<T>) => tx(db, n.tenantId, fn);
      let o = await run((s) => createOrderDraft(s, c, { items: [{ catalogueItemId: n.tikka, quantity: 1 }], customerId: n.customerId }));
      o = await run((s) => placeOrder(s, c, { orderId: o.id }));
      assert.equal(o.statusLabel, "Incoming");
      assert.deepEqual(o.allowedNext, ["ACCEPTED", "CANCELLED"]);
      await rejectsWith(() => run((s) => rejectOrder(s, c, { orderId: o.id, expectedVersion: o.version })), "INVALID_TRANSITION");
      o = await run((s) => acceptOrder(s, c, { orderId: o.id, expectedVersion: o.version }));
      await rejectsWith(() => run((s) => cancelOrder(s, c, { orderId: o.id })), "INVALID_TRANSITION");
      o = await run((s) => startProcessing(s, c, { orderId: o.id, expectedVersion: o.version }));
      assert.equal(o.status, "PROCESSING");
    } finally {
      setPackResolver(null);
    }
  });

  it("an unknown pack id is PACK_INVALID", async () => {
    const n = await restaurantFixture(db, "no-such-pack");
    await rejectsWith(() => tx(db, n.tenantId, (s) => createOrderDraft(s, ctxFor(n.tenantId), { items: [{ catalogueItemId: n.tikka, quantity: 1 }] })), "PACK_INVALID");
  });
});

describe("optimistic version", () => {
  it("a stale version is VERSION_CONFLICT and changes nothing", async () => {
    const o = await place(await newDraft());
    const accepted = await step(acceptOrder, o);
    const e = await rejectsWith(() => step(startProcessing, o), "VERSION_CONFLICT", "ORDER_VERSION_CONFLICT");
    assert.equal(e.details.expectedVersion, o.version);
    assert.equal(e.details.currentVersion, accepted.version);
    const same = await call((s) => getOrder(s, ctx(), { orderId: o.id }));
    assert.equal(same.status, "ACCEPTED");
    assert.equal(same.version, accepted.version);
  });

  it("8 concurrent accepts with the same version: exactly one wins, one event", async () => {
    const o = await place(await newDraft());
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => step(acceptOrder, o)));
    const ok = settled.filter((s) => s.status === "fulfilled");
    const bad = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 7);
    for (const b of bad) assert.equal((b.reason as { code: string }).code, "VERSION_CONFLICT");
    const final = await call((s) => getOrder(s, ctx(), { orderId: o.id }));
    assert.equal(final.version, o.version + 1);
    assert.equal((await events(o.id)).filter((e) => e.type === "order.accepted").length, 1);
  });

  it("accept racing cancel from the same version: one wins, the other conflicts, state is consistent", async () => {
    for (let round = 0; round < 5; round++) {
      const o = await place(await newDraft());
      const [a, c] = await Promise.allSettled([step(acceptOrder, o), call((s) => cancelOrder(s, ctx(), { orderId: o.id, expectedVersion: o.version }))]);
      assert.equal([a, c].filter((r) => r.status === "fulfilled").length, 1, `round ${round}`);
      const final = await call((s) => getOrder(s, ctx(), { orderId: o.id }));
      assert.equal(final.version, o.version + 1);
      assert.ok(final.status === "ACCEPTED" || final.status === "CANCELLED");
      const types = (await events(o.id)).map((e) => e.type);
      assert.equal(types.filter((t) => t === "order.accepted" || t === "order.cancelled").length, 1);
    }
  });

  it("without expectedVersion (the AI cancel path) the move still serialises on the row lock", async () => {
    const o = await place(await newDraft());
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => call((s) => cancelOrder(s, ctx(), { orderId: o.id }))));
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
    for (const s of settled.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) assert.equal((s.reason as { code: string }).code, "INVALID_TRANSITION");
  });

  it("editing a line while another edit is in flight conflicts instead of overwriting", async () => {
    const o = await newDraft();
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => call((s) => addItem(s, ctx(), { orderId: o.id, expectedVersion: o.version, item: { catalogueItemId: fx.papad, quantity: 1 } }))));
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
    const final = await call((s) => getOrder(s, ctx(), { orderId: o.id }));
    assert.equal(final.items.find((i) => i.name === "Papad")?.quantity, 1);
  });
});

describe("placeOrder rules", () => {
  it("an empty order cannot be placed", async () => {
    const o = await newDraft();
    const emptied = await call((s) => removeItem(s, ctx(), { orderId: o.id, expectedVersion: o.version, itemId: o.items[0]!.id }));
    const emptied2 = await call((s) => removeItem(s, ctx(), { orderId: o.id, expectedVersion: emptied.version, itemId: emptied.items[0]!.id }));
    await rejectsWith(() => place(emptied2), "VALIDATION_FAILED", "ORDER_EMPTY");
    assert.equal((await call((s) => getOrder(s, ctx(), { orderId: o.id }))).status, "DRAFT");
  });

  it("the pack's required customer fields (restaurant: name and phone) are enforced", async () => {
    const noCustomer = await newDraft(null);
    const e = await rejectsWith(() => place(noCustomer), "REQUIRED_FIELDS_MISSING", "ORDER_REQUIRED_FIELDS_MISSING");
    assert.deepEqual(e.details.missing, ["name", "phone"]);

    const noPhone = await call((s) => insert(s, "customers", { tenant_id: fx.tenantId, name: "No Phone" }));
    const e2 = await rejectsWith(() => call((s) => placeOrder(s, ctx(), { orderId: noCustomer.id, customerId: noPhone })), "REQUIRED_FIELDS_MISSING");
    assert.deepEqual(e2.details.missing, ["phone"]);
    assert.equal((await call((s) => getOrder(s, ctx(), { orderId: noCustomer.id }))).status, "DRAFT");

    const placed = await call((s) => placeOrder(s, ctx(), { orderId: noCustomer.id, customerId: fx.customerId }));
    assert.equal(placed.customerId, fx.customerId);
    assert.equal(placed.status, "PLACED");
  });

  it("an inline customer is found by phone, or created once with customer.created", async () => {
    const existing = await call((s) => createOrderDraft(s, ctx(), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] }));
    const before = await call((s) => count(s, "select count(*) as n from customers where tenant_id = $1", [fx.tenantId]));
    const found = await call((s) => placeOrder(s, ctx(), { orderId: existing.id, customer: { name: "Whoever", phone: "9811100001" } }));
    assert.equal(found.customerId, fx.customerId, "ten digits are read as +91 and matched to the existing customer");
    assert.equal(await call((s) => count(s, "select count(*) as n from customers where tenant_id = $1", [fx.tenantId])), before);

    const fresh = await call((s) => createOrderDraft(s, ctx(), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] }));
    const placed = await call((s) => placeOrder(s, ctx(), { orderId: fresh.id, customer: { name: "Chitra Nair", phone: "+919822200003", email: "Chitra@Example.com" } }));
    assert.ok(placed.customerId && placed.customerId !== fx.customerId);
    const row = await call((s) => s.query("select name, phone, email, source from customers where id = $1", [placed.customerId]));
    assert.deepEqual(row.rows[0], { name: "Chitra Nair", phone: "+919822200003", email: "chitra@example.com", source: "dashboard" });
    const ev = await call((s) => s.query("select type from outbox_events where tenant_id = $1 and aggregate_id = $2", [fx.tenantId, placed.customerId]));
    assert.deepEqual(ev.rows.map((r) => r.type), ["customer.created"]);

    const bad = await call((s) => createOrderDraft(s, ctx(), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] }));
    await rejectsWith(() => call((s) => placeOrder(s, ctx(), { orderId: bad.id, customer: { name: "X", phone: "+1234" } })), "VALIDATION_FAILED");
    await rejectsWith(() => call((s) => placeOrder(s, ctx(), { orderId: bad.id, customerId: fx.customerId, customer: { name: "Y", phone: "+919822200009" } })), "VALIDATION_FAILED");
  });

  it("an item that went unavailable since the draft blocks placement; prices stay the snapshot", async () => {
    const o = await newDraft();
    await call((s) => s.query("update catalogue_items set available = false where id = $1", [fx.soda]));
    try {
      await rejectsWith(() => place(o), "CONFLICT", "ORDER_ITEM_UNAVAILABLE");
    } finally {
      await call((s) => s.query("update catalogue_items set available = true, base_price_paise = 9999 where id = $1", [fx.soda]));
    }
    const placed = await place(o);
    assert.equal(placed.items.find((i) => i.name === "Lime soda")?.unitPricePaise, 4950);
    assert.equal(placed.totalPaise, o.totalPaise);
    await call((s) => s.query("update catalogue_items set base_price_paise = 4950 where id = $1", [fx.soda]));
  });

  it("totals are frozen once placed: no line, discount or note edits", async () => {
    const o = await place(await newDraft());
    await rejectsWith(() => call((s) => addItem(s, ctx(), { orderId: o.id, expectedVersion: o.version, item: { catalogueItemId: fx.papad, quantity: 1 } })), "INVALID_TRANSITION", "ORDER_INVALID_STATE");
    await rejectsWith(() => call((s) => updateItem(s, ctx(), { orderId: o.id, expectedVersion: o.version, itemId: o.items[0]!.id, quantity: 9 })), "INVALID_TRANSITION", "ORDER_INVALID_STATE");
    await rejectsWith(() => call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: o.version, kind: "fixed", amountPaise: 100 })), "INVALID_TRANSITION", "ORDER_INVALID_STATE");
    const same = await call((s) => getOrder(s, ctx(), { orderId: o.id }));
    assert.equal(same.totalPaise, o.totalPaise);
    assert.equal(same.version, o.version);
  });

  it("fulfilment can change until preparation starts", async () => {
    let o = await place(await newDraft());
    o = await call((s) => setFulfilment(s, ctx(), { orderId: o.id, expectedVersion: o.version, fulfilment: { type: "pickup" } }));
    o = await step(acceptOrder, o);
    o = await call((s) => setFulfilment(s, ctx(), { orderId: o.id, expectedVersion: o.version, fulfilment: { type: "dine_in", tableLabel: "9" } }));
    o = await step(startProcessing, o);
    await rejectsWith(() => call((s) => setFulfilment(s, ctx(), { orderId: o.id, expectedVersion: o.version, fulfilment: { type: "pickup" } })), "INVALID_TRANSITION");
  });

  it("a discounted order places with its discount and frozen totals intact", async () => {
    let o = await newDraft();
    o = await call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: o.version, kind: "percent", bps: 1000 }));
    const placed = await place(o);
    assert.equal(placed.discountPaise, o.discountPaise);
    assert.equal(placed.totalPaise, o.totalPaise);
    assert.equal(placed.taxPaise, o.taxPaise);
  });

  it("onBehalfOfCustomerId: a customer-facing call cannot place or cancel someone else's order, and cannot swap the customer", async () => {
    const o = await newDraft(fx.customerId);
    await rejectsWith(() => call((s) => placeOrder(s, ctx({ channel: "whatsapp" }), { orderId: o.id, onBehalfOfCustomerId: fx.otherCustomerId })), "NOT_FOUND", "ORDER_NOT_FOUND");
    await rejectsWith(() => call((s) => cancelOrder(s, ctx({ channel: "whatsapp" }), { orderId: o.id, onBehalfOfCustomerId: fx.otherCustomerId })), "NOT_FOUND", "ORDER_NOT_FOUND");
    await rejectsWith(() => call((s) => placeOrder(s, ctx({ channel: "whatsapp" }), { orderId: o.id, onBehalfOfCustomerId: fx.customerId, customerId: fx.otherCustomerId })), "VALIDATION_FAILED", "CUSTOMER_CHANGE_NOT_ALLOWED");
    await rejectsWith(() => call((s) => placeOrder(s, ctx({ channel: "whatsapp" }), { orderId: o.id, onBehalfOfCustomerId: fx.customerId, customer: { name: "Mallory", phone: "+919800000000" } })), "VALIDATION_FAILED", "CUSTOMER_CHANGE_NOT_ALLOWED");
    const placed = await call((s) => placeOrder(s, ctx({ channel: "whatsapp" }), { orderId: o.id, onBehalfOfCustomerId: fx.customerId }));
    assert.equal(placed.status, "PLACED");
    const cancelled = await call((s) => cancelOrder(s, ctx({ channel: "whatsapp" }), { orderId: o.id, onBehalfOfCustomerId: fx.customerId, reason: "changed my mind" }));
    assert.equal(cancelled.status, "CANCELLED");
  });
});

describe("reject and cancel", () => {
  it("rejecting a placed order records the reason; the event says REJECTED", async () => {
    const o = await place(await newDraft());
    const r = await call((s) => rejectOrder(s, ctx(), { orderId: o.id, expectedVersion: o.version, reason: "kitchen closed" }));
    assert.equal(r.status, "REJECTED");
    assert.equal(r.statusLabel, "Declined");
    assert.equal(r.cancellationReason, "kitchen closed");
    const last = (await events(o.id)).at(-1)!;
    assert.equal(last.type, "order.cancelled");
    assert.equal(last.payload.status, "REJECTED");
    assert.equal(last.payload.previousStatus, "PLACED");
    assert.equal(last.payload.reason, "kitchen closed");
  });

  it("cancelling a draft sends no event (it was never announced); cancelling a placed order does", async () => {
    const d = await newDraft();
    const c = await call((s) => cancelOrder(s, ctx(), { orderId: d.id }));
    assert.equal(c.status, "CANCELLED");
    assert.deepEqual((await events(d.id)).map((e) => e.type), []);
    const p = await place(await newDraft());
    await call((s) => cancelOrder(s, ctx(), { orderId: p.id }));
    assert.deepEqual((await events(p.id)).map((e) => e.type), ["order.created", "order.cancelled"]);
  });

  it("an unpaid order cancels with no refund entry", async () => {
    const p = await place(await newDraft());
    await call((s) => cancelOrder(s, ctx(), { orderId: p.id }));
    assert.equal(await call((s) => count(s, "select count(*) as n from payments where order_id = $1", [p.id])), 0);
  });

  it("cancelling a paid order makes CANCELLED plus one refund entry for everything held", async () => {
    const p = await place(await newDraft());
    await call((s) => recordPayment(s, ctx(), { orderId: p.id, amountPaise: 5000, method: "upi" }));
    await call((s) => recordPayment(s, ctx(), { orderId: p.id, amountPaise: 3000, method: "cash" }));
    const c = await call((s) => cancelOrder(s, ctx(), { orderId: p.id, refundMethod: "upi", reason: "customer left" }));
    assert.equal(c.status, "CANCELLED");
    assert.equal(c.paymentStatus, "refunded");
    assert.equal(c.payment.netPaidPaise, 0);
    assert.equal(c.payment.refundedPaise, 8000);
    const rows = await call((s) => s.query("select kind, method, amount_paise::int as amount, status from payments where order_id = $1 order by created_at, id", [p.id]));
    assert.deepEqual(rows.rows.map((r) => [r.kind, r.method, r.amount, r.status]), [["payment", "upi", 5000, "completed"], ["payment", "cash", 3000, "completed"], ["refund", "upi", 8000, "completed"]]);
    const ev = (await events(p.id)).map((e) => e.type).sort();
    assert.deepEqual(ev, ["order.cancelled", "order.created", "payment.completed", "payment.completed", "payment.completed"]);
    const refundEvent = (await events(p.id)).find((e) => e.type === "payment.completed" && e.payload.kind === "refund");
    assert.equal(refundEvent?.payload.amountPaise, 8000);
  });
});

describe("outbox: once, and only on commit", () => {
  it("a transaction that fails after the change rolls back status, version and event together", async () => {
    const o = await place(await newDraft());
    const eventsBefore = (await events(o.id)).length;
    await assert.rejects(
      withTenant(db.app, fx.tenantId, async (s) => {
        const r = await acceptOrder(s, ctx(), { orderId: o.id, expectedVersion: o.version });
        assert.equal(r.status, "ACCEPTED");
        throw new Error("boom after the engine call");
      }),
      /boom/,
    );
    const same = await call((s) => getOrder(s, ctx(), { orderId: o.id }));
    assert.equal(same.status, "PLACED");
    assert.equal(same.version, o.version);
    assert.equal((await events(o.id)).length, eventsBefore);
    // and the same call afterwards works once
    await step(acceptOrder, o);
    assert.equal((await events(o.id)).filter((e) => e.type === "order.accepted").length, 1);
  });

  it("a placement that fails on required fields leaves no customer and no customer.created event", async () => {
    const d = await call((s) => createOrderDraft(s, ctx(), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] }));
    const customers = await call((s) => count(s, "select count(*) as n from customers where tenant_id = $1", [fx.tenantId]));
    const created = await call((s) => count(s, "select count(*) as n from outbox_events where tenant_id = $1 and type = 'customer.created'", [fx.tenantId]));
    // inline customer without a phone: the customer would be created, then the pack check fails and everything rolls back
    await rejectsWith(() => call((s) => placeOrder(s, ctx(), { orderId: d.id, customer: { name: "Rolled Back" } })), "REQUIRED_FIELDS_MISSING");
    assert.equal(await call((s) => count(s, "select count(*) as n from customers where tenant_id = $1", [fx.tenantId])), customers);
    assert.equal(await call((s) => count(s, "select count(*) as n from outbox_events where tenant_id = $1 and type = 'customer.created'", [fx.tenantId])), created);
  });

  it("every order event has a unique eventId, a valid type and only ids and amounts", async () => {
    const res = await call((s) => s.query<{ event_id: string; type: string; payload: Record<string, unknown>; status: string }>("select event_id, type, payload, status from outbox_events where tenant_id = $1", [fx.tenantId]));
    assert.ok(res.rows.length > 10);
    assert.equal(new Set(res.rows.map((r) => r.event_id)).size, res.rows.length);
    for (const r of res.rows) {
      assert.equal(r.status, "pending");
      const text = JSON.stringify(r.payload);
      assert.ok(!/Asha|Bala|Chitra|@example|\+91/.test(text), `no personal data in ${r.type}`);
    }
  });
});

describe("getOrder", () => {
  it("unknown ids are NOT_FOUND", async () => {
    await rejectsWith(() => call((s) => getOrder(s, ctx(), { orderId: randomUUID() })), "NOT_FOUND", "ORDER_NOT_FOUND");
    await rejectsWith(() => call((s) => getOrder(s, ctx(), { orderId: "nope" })), "VALIDATION_FAILED");
    await rejectsWith(() => call((s) => getOrder(s, ctx(), { orderId: randomUUID(), tenantId: fx.tenantId } as never)), "VALIDATION_FAILED");
  });
});
