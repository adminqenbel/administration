// Customer-channel safety (security review SEC-007, SEC-009, SEC-010, SEC-022 and the limits around them): ownership comes
// only from ctx.subject, fails closed, and looks the same as "no such order"; staff operations, discounts and overrides
// are closed to customer channels; idempotency keys are bound to the caller; sizes are bounded server-side.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { toErrorBody, type AppError, type Channel, type EngineContext } from "@qenbel/shared";
import {
  MAX_DRAFTS_PER_CUSTOMER_PER_DAY,
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
let fx: Fixture;
let extraItems: string[] = [];

const CUSTOMER_CHANNELS: Channel[] = ["web_chat", "whatsapp", "voice"];

before(async () => {
  db = await connect();
  fx = await restaurantFixture(db);
  extraItems = await tx(db, fx.tenantId, async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(await insert(c, "catalogue_items", { tenant_id: fx.tenantId, kind: "product", name: `Bulk ${i}`, base_price_paise: 100, tax_rate_bps: 0 }));
    return ids;
  });
});
after(async () => {
  await db.close();
});

const call = <T>(fn: (c: Client) => Promise<T>) => tx(db, fx.tenantId, fn);
const staff = (extra: Partial<EngineContext> & { channel?: Channel } = {}) => ctxFor(fx.tenantId, extra);
const asCustomer = (channel: Channel, customerId: string | undefined, extra: Partial<EngineContext> = {}) =>
  ctxFor(fx.tenantId, { channel, actor: { kind: "api_credential", id: "cred-chat", channel }, ...(customerId ? { subject: { customerId } } : {}), ...extra });

async function placedOrderOf(customerId: string, paid = 0): Promise<OrderView> {
  const d = await call((s) => createOrderDraft(s, staff(), { items: [{ catalogueItemId: fx.tikka, quantity: 2 }], customerId }));
  const p = await call((s) => placeOrder(s, staff(), { orderId: d.id }));
  if (paid > 0) await call((s) => recordPayment(s, staff(), { orderId: p.id, amountPaise: paid, method: "cash" }));
  return p;
}
const orderNow = (id: string) => call((s) => getOrder(s, staff(), { orderId: id }));

describe("SEC-007: ownership is fail-closed and comes only from ctx.subject", () => {
  it("[the review's PoC] a customer-channel cancel with no verified contact is refused and changes nothing", async () => {
    const o = await placedOrderOf(fx.customerId, 5000);
    const wa = asCustomer("whatsapp", undefined);
    let status = "";
    try {
      status = (await call((s) => cancelOrder(s, wa, { orderId: o.id }))).status;
    } catch {
      status = "refused";
    }
    assert.equal(status, "refused");
    const after = await orderNow(o.id);
    assert.equal(after.status, "PLACED");
    assert.equal(after.version, o.version);
    assert.equal(after.payment.refundedPaise, 0, "no refund entry was written");
  });

  it("onBehalfOfCustomerId is gone: a body that carries it is VALIDATION_FAILED", async () => {
    const o = await placedOrderOf(fx.customerId);
    const wa = asCustomer("whatsapp", fx.customerId);
    await rejectsWith(() => call((s) => cancelOrder(s, wa, { orderId: o.id, onBehalfOfCustomerId: fx.customerId } as never)), "VALIDATION_FAILED");
    await rejectsWith(() => call((s) => placeOrder(s, wa, { orderId: o.id, onBehalfOfCustomerId: fx.customerId } as never)), "VALIDATION_FAILED");
    await rejectsWith(() => call((s) => getOrderStatusForChannel(s, wa, { orderId: o.id, customerId: fx.customerId } as never)), "VALIDATION_FAILED");
    assert.equal((await orderNow(o.id)).version, o.version);
  });

  for (const channel of CUSTOMER_CHANNELS) {
    it(`${channel}: no subject, a stranger, an anonymous order and a missing order all give one identical NOT_FOUND body`, async () => {
      const mine = await placedOrderOf(fx.customerId);
      const anon = await call((s) => createOrderDraft(s, staff(), { items: [{ catalogueItemId: fx.papad, quantity: 1 }] }));
      const targets: Record<string, string> = { foreign: mine.id, anonymous: anon.id, missing: randomUUID() };
      const callers: Record<string, (c: EngineContext, id: string) => Promise<unknown>> = {
        placeOrder: (c, id) => call((s) => placeOrder(s, c, { orderId: id })),
        cancelOrder: (c, id) => call((s) => cancelOrder(s, c, { orderId: id })),
        getOrder: (c, id) => call((s) => getOrder(s, c, { orderId: id })),
        getOrderStatusForChannel: (c, id) => call((s) => getOrderStatusForChannel(s, c, { orderId: id })),
      };
      const bodies = new Set<string>();
      for (const [name, fn] of Object.entries(callers)) {
        for (const [kind, id] of Object.entries(targets)) {
          for (const who of ["no subject", "stranger"] as const) {
            const c = asCustomer(channel, who === "stranger" ? fx.otherCustomerId : undefined);
            const err = await fn(c, id).then(() => assert.fail(`${name}/${kind}/${who} succeeded`), (e: unknown) => e as AppError);
            assert.equal(err.code, "NOT_FOUND", `${name}/${kind}/${who}`);
            bodies.add(JSON.stringify(toErrorBody(err)));
          }
        }
      }
      assert.equal(bodies.size, 1, `distinguishable error bodies: ${[...bodies].join(" | ")}`);
      const after = await orderNow(mine.id);
      assert.equal(after.status, "PLACED");
      assert.equal(after.version, mine.version);
    });

    it(`${channel}: the verified owner can view, place and cancel their own order`, async () => {
      const d = await call((s) => createOrderDraft(s, asCustomer(channel, fx.customerId), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] }));
      assert.equal(d.customerId, fx.customerId);
      assert.equal(d.source, channel);
      const owner = asCustomer(channel, fx.customerId);
      assert.equal((await call((s) => getOrder(s, owner, { orderId: d.id }))).id, d.id);
      assert.equal((await call((s) => getOrderStatusForChannel(s, owner, { orderId: d.id }))).status, "DRAFT");
      const placed = await call((s) => placeOrder(s, owner, { orderId: d.id }));
      assert.equal(placed.status, "PLACED");
      const cancelled = await call((s) => cancelOrder(s, owner, { orderId: d.id, reason: "changed my mind" }));
      assert.equal(cancelled.status, "CANCELLED");
    });
  }

  it("a customer channel cannot swap, create or pick the order's customer when placing", async () => {
    const d = await call((s) => createOrderDraft(s, asCustomer("whatsapp", fx.customerId), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] }));
    const wa = asCustomer("whatsapp", fx.customerId);
    await rejectsWith(() => call((s) => placeOrder(s, wa, { orderId: d.id, customerId: fx.otherCustomerId })), "VALIDATION_FAILED", "CUSTOMER_CHANGE_NOT_ALLOWED");
    await rejectsWith(() => call((s) => placeOrder(s, wa, { orderId: d.id, customer: { name: "Mallory", phone: "+919800000000" } })), "VALIDATION_FAILED", "CUSTOMER_CHANGE_NOT_ALLOWED");
    const ok = await call((s) => placeOrder(s, wa, { orderId: d.id, customerId: fx.customerId }));
    assert.equal(ok.customerId, fx.customerId);
  });

  it("pack-required fields are checked on the subject's own customer record", async () => {
    const noPhone = await call((s) => insert(s, "customers", { tenant_id: fx.tenantId, name: "No Phone" }));
    const c = asCustomer("whatsapp", noPhone);
    const d = await call((s) => createOrderDraft(s, c, { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] }));
    const e = await rejectsWith(() => call((s) => placeOrder(s, c, { orderId: d.id })), "REQUIRED_FIELDS_MISSING");
    assert.deepEqual(e.details.missing, ["phone"]);
  });

  it("a customer cannot cancel a paid order into someone else's refund method", async () => {
    const o = await placedOrderOf(fx.customerId, 3000);
    const owner = asCustomer("whatsapp", fx.customerId);
    await rejectsWith(() => call((s) => cancelOrder(s, owner, { orderId: o.id, refundMethod: "cash" })), "VALIDATION_FAILED", "REFUND_METHOD_NOT_ALLOWED");
    const c = await call((s) => cancelOrder(s, owner, { orderId: o.id }));
    assert.equal(c.status, "CANCELLED");
    assert.equal(c.payment.netPaidPaise, 0);
  });
});

describe("customer channels cannot reach staff operations", () => {
  it("every staff operation is FORBIDDEN for web_chat, whatsapp and voice (with or without a subject), and changes nothing", async () => {
    const o = await placedOrderOf(fx.customerId, 1000);
    const draft = await call((s) => createOrderDraft(s, staff(), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }], customerId: fx.customerId }));
    const v = o.version;
    const ops: [string, (c: EngineContext) => Promise<unknown>][] = [
      ["acceptOrder", (c) => call((s) => acceptOrder(s, c, { orderId: o.id, expectedVersion: v }))],
      ["startProcessing", (c) => call((s) => startProcessing(s, c, { orderId: o.id, expectedVersion: v }))],
      ["markReady", (c) => call((s) => markReady(s, c, { orderId: o.id, expectedVersion: v }))],
      ["fulfil", (c) => call((s) => fulfil(s, c, { orderId: o.id, expectedVersion: v }))],
      ["rejectOrder", (c) => call((s) => rejectOrder(s, c, { orderId: o.id, expectedVersion: v }))],
      ["transitionOrder", (c) => call((s) => transitionOrder(s, c, { orderId: o.id, to: "ACCEPTED", expectedVersion: v }))],
      ["recordPayment", (c) => call((s) => recordPayment(s, c, { orderId: o.id, amountPaise: 100, method: "cash" }))],
      ["recordRefund", (c) => call((s) => recordRefund(s, c, { orderId: o.id, amountPaise: 100, method: "cash" }))],
      ["listPayments", (c) => call((s) => listPayments(s, c, { orderId: o.id }))],
      ["addItem", (c) => call((s) => addItem(s, c, { orderId: draft.id, expectedVersion: draft.version, item: { catalogueItemId: fx.papad, quantity: 1 } }))],
      ["updateItem", (c) => call((s) => updateItem(s, c, { orderId: draft.id, expectedVersion: draft.version, itemId: draft.items[0]!.id, quantity: 5 }))],
      ["removeItem", (c) => call((s) => removeItem(s, c, { orderId: draft.id, expectedVersion: draft.version, itemId: draft.items[0]!.id }))],
      ["updateOrderNotes", (c) => call((s) => updateOrderNotes(s, c, { orderId: draft.id, expectedVersion: draft.version, notes: "x" }))],
      ["applyDiscount", (c) => call((s) => applyDiscount(s, c, { orderId: draft.id, expectedVersion: draft.version, kind: "percent", bps: 100 }))],
      ["removeDiscount", (c) => call((s) => removeDiscount(s, c, { orderId: draft.id, expectedVersion: draft.version }))],
      ["setFulfilment", (c) => call((s) => setFulfilment(s, c, { orderId: draft.id, expectedVersion: draft.version, fulfilment: { type: "pickup" } }))],
      ["getOrderBoard", (c) => call((s) => getOrderBoard(s, c))],
    ];
    for (const channel of CUSTOMER_CHANNELS) {
      for (const subject of [undefined, fx.customerId]) {
        for (const [name, fn] of ops) {
          const e = await rejectsWith(() => fn(asCustomer(channel, subject)), "FORBIDDEN", "CHANNEL_NOT_ALLOWED");
          assert.equal(e.details.operation, name);
        }
      }
    }
    const a = await orderNow(o.id);
    assert.equal(a.status, "PLACED");
    assert.equal(a.version, v);
    assert.equal(a.payment.paidPaise, 1000);
    assert.equal(a.payment.refundedPaise, 0);
    const d2 = await orderNow(draft.id);
    assert.equal(d2.version, draft.version);
    assert.equal(d2.items.length, 1);
  });

  it("the api channel is an unscoped integration: it works as staff without a subject, and as a customer with one", async () => {
    const o = await placedOrderOf(fx.customerId);
    const api = ctxFor(fx.tenantId, { channel: "api", actor: { kind: "api_credential", id: "cred-shop", channel: "api" } });
    const accepted = await call((s) => acceptOrder(s, api, { orderId: o.id, expectedVersion: o.version }));
    assert.equal(accepted.status, "ACCEPTED");
    const scoped = { ...api, subject: { customerId: fx.otherCustomerId } };
    await rejectsWith(() => call((s) => getOrder(s, scoped, { orderId: o.id })), "NOT_FOUND", "ORDER_NOT_FOUND");
    await rejectsWith(() => call((s) => cancelOrder(s, scoped, { orderId: o.id })), "NOT_FOUND", "ORDER_NOT_FOUND");
    await rejectsWith(() => call((s) => startProcessing(s, scoped, { orderId: o.id, expectedVersion: accepted.version })), "FORBIDDEN", "CHANNEL_NOT_ALLOWED");
    const own = { ...api, subject: { customerId: fx.customerId } };
    assert.equal((await call((s) => getOrder(s, own, { orderId: o.id }))).id, o.id);
  });

  it("discount and cap override: never from a customer channel; the override only from the dashboard", async () => {
    const d = await call((s) => createOrderDraft(s, staff(), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }], customerId: fx.customerId }));
    for (const channel of CUSTOMER_CHANNELS) {
      await rejectsWith(() => call((s) => applyDiscount(s, asCustomer(channel, fx.customerId), { orderId: d.id, expectedVersion: d.version, kind: "percent", bps: 1500, capOverride: true })), "FORBIDDEN", "CHANNEL_NOT_ALLOWED");
    }
    const api = ctxFor(fx.tenantId, { channel: "api", actor: { kind: "api_credential", id: "cred-shop", channel: "api" } });
    await rejectsWith(() => call((s) => applyDiscount(s, api, { orderId: d.id, expectedVersion: d.version, kind: "percent", bps: 5000, capOverride: true })), "FORBIDDEN", "CAP_OVERRIDE_NOT_ALLOWED");
    await rejectsWith(() => call((s) => applyDiscount(s, api, { orderId: d.id, expectedVersion: d.version, kind: "percent", bps: 100, capOverride: true })), "FORBIDDEN", "CAP_OVERRIDE_NOT_ALLOWED");
    await rejectsWith(() => call((s) => applyDiscount(s, api, { orderId: d.id, expectedVersion: d.version, kind: "percent", bps: 5000 })), "FORBIDDEN", "DISCOUNT_CAP_EXCEEDED");
    const small = await call((s) => applyDiscount(s, api, { orderId: d.id, expectedVersion: d.version, kind: "percent", bps: 500 }));
    assert.equal(small.discountPaise, 500);
    const dash = await call((s) => applyDiscount(s, staff(), { orderId: d.id, expectedVersion: small.version, kind: "percent", bps: 5000, capOverride: true }));
    assert.equal(dash.discountPaise, 5000);
    assert.equal((await orderNow(d.id)).discountPaise, 5000);
  });
});

describe("customer-channel drafts and lists are bounded and scoped", () => {
  it("a draft needs a verified customer and belongs to them; another customer's id is refused", async () => {
    await rejectsWith(() => call((s) => createOrderDraft(s, asCustomer("web_chat", undefined), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] })), "FORBIDDEN", "CUSTOMER_REQUIRED");
    const c = asCustomer("web_chat", fx.customerId);
    await rejectsWith(() => call((s) => createOrderDraft(s, c, { items: [{ catalogueItemId: fx.tikka, quantity: 1 }], customerId: fx.otherCustomerId })), "NOT_FOUND", "CUSTOMER_NOT_FOUND");
    const d = await call((s) => createOrderDraft(s, c, { items: [{ catalogueItemId: fx.tikka, quantity: 1 }], customerId: fx.customerId }));
    assert.equal(d.customerId, fx.customerId);
  });

  it("a conversation id on the subject is stored; an unknown one is refused", async () => {
    const conv = await call((s) => insert(s, "conversations", { tenant_id: fx.tenantId, channel: "whatsapp", customer_id: fx.customerId }));
    const c = asCustomer("whatsapp", fx.customerId, { subject: { customerId: fx.customerId, conversationId: conv } });
    const d = await call((s) => createOrderDraft(s, c, { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] }));
    const row = await call((s) => s.query("select conversation_id from orders where id = $1", [d.id]));
    assert.equal(row.rows[0]?.conversation_id, conv);
    const bad = asCustomer("whatsapp", fx.customerId, { subject: { customerId: fx.customerId, conversationId: randomUUID() } });
    await rejectsWith(() => call((s) => createOrderDraft(s, bad, { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] })), "NOT_FOUND");
  });

  it("server-side size limits: 99 per line, 50 lines, 500 items on a customer channel; staff get 999, 100 and 5000", async () => {
    const c = asCustomer("web_chat", fx.customerId);
    await rejectsWith(() => call((s) => createOrderDraft(s, c, { items: [{ catalogueItemId: fx.papad, quantity: 100 }] })), "VALIDATION_FAILED", "QUANTITY_LIMIT");
    await rejectsWith(() => call((s) => createOrderDraft(s, c, { items: [{ catalogueItemId: fx.papad, quantity: 99 }, { catalogueItemId: fx.papad, quantity: 1 }] })), "VALIDATION_FAILED", "QUANTITY_LIMIT");
    await rejectsWith(() => call((s) => createOrderDraft(s, c, { items: extraItems.slice(0, 51).map((id) => ({ catalogueItemId: id, quantity: 1 })) })), "VALIDATION_FAILED", "LINE_LIMIT");
    await rejectsWith(() => call((s) => createOrderDraft(s, c, { items: extraItems.slice(0, 6).map((id) => ({ catalogueItemId: id, quantity: 99 })) })), "VALIDATION_FAILED", "UNIT_LIMIT");
    const ok = await call((s) => createOrderDraft(s, c, { items: extraItems.slice(0, 50).map((id) => ({ catalogueItemId: id, quantity: 1 })) }));
    assert.equal(ok.items.length, 50);
    // staff: 100 lines fine, but 6 x 999 units is over the 5000-unit ceiling
    const lots = await call((s) => createOrderDraft(s, staff(), { items: extraItems.slice(0, 5).map((id) => ({ catalogueItemId: id, quantity: 999 })) }));
    assert.equal(lots.items.length, 5);
    await rejectsWith(() => call((s) => createOrderDraft(s, staff(), { items: extraItems.slice(0, 6).map((id) => ({ catalogueItemId: id, quantity: 999 })) })), "VALIDATION_FAILED", "UNIT_LIMIT");
    // a staff edit that pushes a draft over the ceiling is refused too
    await rejectsWith(() => call((s) => addItem(s, staff(), { orderId: lots.id, expectedVersion: lots.version, item: { catalogueItemId: extraItems[5]!, quantity: 6 } })), "VALIDATION_FAILED", "UNIT_LIMIT");
    assert.equal((await orderNow(lots.id)).version, lots.version);
  });

  it(`one customer can start at most ${MAX_DRAFTS_PER_CUSTOMER_PER_DAY} orders a day through a customer channel`, async () => {
    const lone = await call((s) => insert(s, "customers", { tenant_id: fx.tenantId, name: "Busy Bee", phone: "+919833300001" }));
    const c = asCustomer("web_chat", lone);
    for (let i = 0; i < MAX_DRAFTS_PER_CUSTOMER_PER_DAY; i++) {
      await call((s) => createOrderDraft(s, c, { items: [{ catalogueItemId: fx.papad, quantity: 1 }] }));
    }
    await rejectsWith(() => call((s) => createOrderDraft(s, c, { items: [{ catalogueItemId: fx.papad, quantity: 1 }] })), "RATE_LIMITED", "DRAFT_LIMIT");
    // staff are not limited by it
    await call((s) => createOrderDraft(s, staff(), { items: [{ catalogueItemId: fx.papad, quantity: 1 }], customerId: lone }));
  });

  it("listOrders: a customer sees only their own, in pages of at most 10; staff pages stop at 100", async () => {
    const lister = await call((s) => insert(s, "customers", { tenant_id: fx.tenantId, name: "Lister", phone: "+919833300002" }));
    for (let i = 0; i < 12; i++) await call((s) => createOrderDraft(s, staff(), { items: [{ catalogueItemId: fx.papad, quantity: 1 }], customerId: lister }));
    const c = asCustomer("whatsapp", lister);
    const page = await call((s) => listOrders(s, c, { limit: 100 }));
    assert.equal(page.items.length, 10);
    assert.ok(page.nextCursor);
    assert.ok(page.items.every((i) => i.customerId === lister));
    const page2 = await call((s) => listOrders(s, c, { limit: 100, cursor: page.nextCursor! }));
    assert.equal(page2.items.length, 2);
    await rejectsWith(() => call((s) => listOrders(s, c, { customerId: fx.customerId })), "NOT_FOUND", "ORDER_NOT_FOUND");
    await rejectsWith(() => call((s) => listOrders(s, asCustomer("whatsapp", undefined), {})), "FORBIDDEN", "CUSTOMER_REQUIRED");
    await rejectsWith(() => call((s) => listOrders(s, staff(), { limit: 101 })), "VALIDATION_FAILED");
    assert.ok((await call((s) => listOrders(s, staff(), { limit: 100 }))).items.length <= 100);
    await rejectsWith(() => call((s) => getOrderBoard(s, staff(), { limitPerStatus: 51 })), "VALIDATION_FAILED");
  });
});

describe("SEC-010: idempotency keys are bound to the caller", () => {
  const input = () => ({ items: [{ catalogueItemId: fx.tikka, quantity: 1 }] });

  it("another credential repeating the key and body gets its own result, never the first caller's", async () => {
    const key = `voice-call-${randomUUID()}-hold-1`;
    const voice = asCustomer("voice", fx.customerId, { idempotencyKey: key, actor: { kind: "api_credential", id: "cred-voice", channel: "voice" } });
    const widget = asCustomer("web_chat", fx.customerId, { idempotencyKey: key, actor: { kind: "api_credential", id: "cred-widget", channel: "web_chat" } });
    const first = await call((s) => createOrderDraft(s, voice, input()));
    const replay = await call((s) => createOrderDraft(s, voice, input()));
    const other = await call((s) => createOrderDraft(s, widget, input()));
    assert.equal(replay.id, first.id, "same caller replays");
    assert.notEqual(other.id, first.id, "a different credential does not receive the first caller's order");
    assert.equal(other.source, "web_chat");
  });

  it("a different body under someone else's key is a plain miss: no IDEMPOTENCY_CONFLICT oracle", async () => {
    const key = `probe-${randomUUID()}`;
    const owner = staff({ idempotencyKey: key, actor: { kind: "user", id: "user-1", channel: "dashboard" } });
    const prober = staff({ idempotencyKey: key, actor: { kind: "user", id: "user-2", channel: "dashboard" } });
    await call((s) => createOrderDraft(s, owner, input()));
    const mine = await call((s) => createOrderDraft(s, prober, { items: [{ catalogueItemId: fx.soda, quantity: 3 }] }));
    assert.equal(mine.items[0]?.quantity, 3);
    // while the owner changing the body under their own key still conflicts
    await rejectsWith(() => call((s) => createOrderDraft(s, owner, { items: [{ catalogueItemId: fx.soda, quantity: 3 }] })), "IDEMPOTENCY_CONFLICT");
  });

  it("the same credential acting for two customers does not share a key either; payments are bound the same way", async () => {
    const key = `shared-${randomUUID()}`;
    const forA = asCustomer("whatsapp", fx.customerId, { idempotencyKey: key });
    const forB = asCustomer("whatsapp", fx.otherCustomerId, { idempotencyKey: key });
    const a = await call((s) => createOrderDraft(s, forA, input()));
    const b = await call((s) => createOrderDraft(s, forB, input()));
    assert.notEqual(a.id, b.id);
    assert.equal(b.customerId, fx.otherCustomerId);

    const o = await placedOrderOf(fx.customerId);
    const payKey = `pay-${randomUUID()}`;
    const u1 = staff({ idempotencyKey: payKey, actor: { kind: "user", id: "cashier-1", channel: "dashboard" } });
    const u2 = staff({ idempotencyKey: payKey, actor: { kind: "user", id: "cashier-2", channel: "dashboard" } });
    const p1 = await call((s) => recordPayment(s, u1, { orderId: o.id, amountPaise: 1000, method: "cash" }));
    const p1again = await call((s) => recordPayment(s, u1, { orderId: o.id, amountPaise: 1000, method: "cash" }));
    const p2 = await call((s) => recordPayment(s, u2, { orderId: o.id, amountPaise: 1000, method: "cash" }));
    assert.equal(p1again.payment.id, p1.payment.id);
    assert.notEqual(p2.payment.id, p1.payment.id, "a second cashier's identical request is a new payment, not a replay");
  });
});

describe("SEC-022 and SEC-009: nothing about the schema or other customers leaks through errors", () => {
  it("a unique-violation reaches the caller without constraint names", async () => {
    const a = await placedOrderOf(fx.customerId);
    const b = await placedOrderOf(fx.customerId);
    const input = { amountPaise: 500, method: "upi" as const, provider: "upi-app", providerReference: `ref-${randomUUID()}` };
    await call((s) => recordPayment(s, staff(), { orderId: a.id, ...input }));
    const e = await rejectsWith(() => call((s) => recordPayment(s, staff(), { orderId: b.id, ...input })), "CONFLICT", "DUPLICATE");
    assert.ok(!JSON.stringify(e.details).includes("payments_"), JSON.stringify(e.details));
    assert.equal("constraint" in e.details, false);
  });

  it("an inline customer whose e-mail (or phone) already belongs to a customer reuses that customer: no raw 23505", async () => {
    const existing = await call((s) => insert(s, "customers", { tenant_id: fx.tenantId, name: "Dev Menon", phone: "+919844400001", email: "dev@example.com" }));
    const cases = [
      { name: "Someone New", phone: "+919844400002", email: "DEV@example.com" }, // new phone, e-mail of Dev (any case)
      { name: "Someone New", phone: "+919844400001", email: "other@example.com" }, // Dev's phone, other e-mail
      { name: "Someone New", email: "dev@example.com" }, // e-mail only
    ];
    for (const customer of cases) {
      const d = await call((s) => createOrderDraft(s, staff(), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] }));
      const placed = await call((s) => placeOrder(s, staff(), { orderId: d.id, customer }));
      assert.equal(placed.customerId, existing, JSON.stringify(customer));
    }
    const dups = await call((s) => s.query("select count(*)::int as n from customers where tenant_id = $1 and lower(email) = 'dev@example.com'", [fx.tenantId]));
    assert.equal(dups.rows[0]?.n, 1);
  });
});
