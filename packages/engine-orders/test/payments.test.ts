// The payments ledger against the real Postgres: derivation of payment_status, overpayment and over-refund limits,
// REFUNDED rules, insert-only enforcement, idempotency, concurrency, and a randomised invariant check.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { getPack as registryPackFor } from "@qenbel/config-packs";
import {
  acceptOrder,
  cancelOrder,
  createOrderDraft,
  fulfil,
  getOrder,
  listOrders,
  listPayments,
  markReady,
  placeOrder,
  recordPayment,
  recordRefund,
  rejectOrder,
  setPackResolver,
  startProcessing,
  transitionOrder,
  type OrderView,
} from "../src/index.ts";
import { connect, count, ctxFor, rejectsWith, restaurantFixture, tx, type Client, type Fixture, type TestDb } from "./helpers.ts";

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
const TOTAL = 10500; // one Paneer tikka: 10000 + 5% tax

async function placed(): Promise<OrderView> {
  const d = await call((s) => createOrderDraft(s, ctx(), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }], customerId: fx.customerId }));
  assert.equal(d.totalPaise, TOTAL);
  return call((s) => placeOrder(s, ctx(), { orderId: d.id }));
}
async function fulfilled(): Promise<OrderView> {
  let o = await placed();
  for (const fn of [acceptOrder, startProcessing, markReady, fulfil]) {
    o = await call((s) => fn(s, ctx(), { orderId: o.id, expectedVersion: o.version }));
  }
  return o;
}
const pay = (orderId: string, amountPaise: number, c = ctx(), method: "cash" | "upi" = "cash") => call((s) => recordPayment(s, c, { orderId, amountPaise, method }));
const refund = (orderId: string, amountPaise: number, c = ctx()) => call((s) => recordRefund(s, c, { orderId, amountPaise, method: "cash" }));
const view = (orderId: string) => call((s) => getOrder(s, ctx(), { orderId }));

describe("recordPayment", () => {
  it("partial then full payment: status and balance follow the ledger", async () => {
    const o = await placed();
    assert.equal(o.paymentStatus, "unpaid");
    assert.equal(o.payment.outstandingPaise, TOTAL);
    const a = await pay(o.id, 4000);
    assert.equal(a.order.paymentStatus, "partial");
    assert.equal(a.order.payment.paidPaise, 4000);
    assert.equal(a.order.payment.outstandingPaise, 6500);
    assert.equal(a.payment.kind, "payment");
    assert.equal(a.payment.status, "completed");
    assert.equal(a.payment.amountPaise, 4000);
    assert.equal(a.payment.currency, "INR");
    const b = await pay(o.id, 6500, ctx(), "upi");
    assert.equal(b.order.paymentStatus, "paid");
    assert.equal(b.order.payment.outstandingPaise, 0);
    assert.equal(b.order.payment.netPaidPaise, TOTAL);
    const list = await call((s) => listPayments(s, ctx(), { orderId: o.id }));
    assert.deepEqual(list.entries.map((e) => [e.kind, e.method, e.amountPaise]), [["payment", "cash", 4000], ["payment", "upi", 6500]]);
    assert.deepEqual(list.summary, { paidPaise: 10500, refundedPaise: 0, netPaidPaise: 10500, outstandingPaise: 0 });
  });

  it("queues payment.completed once per entry, with ids and amounts only", async () => {
    const o = await placed();
    const r = await pay(o.id, 2500);
    const ev = await call((s) => s.query<{ payload: Record<string, unknown> }>("select payload from outbox_events where tenant_id = $1 and type = 'payment.completed' and aggregate_id = $2", [fx.tenantId, r.payment.id]));
    assert.equal(ev.rows.length, 1);
    assert.equal(ev.rows[0]?.payload.amountPaise, 2500);
    assert.equal(ev.rows[0]?.payload.orderId, o.id);
    assert.equal(ev.rows[0]?.payload.kind, "payment");
  });

  it("does not bump the order version (the kitchen's view stays valid)", async () => {
    const o = await placed();
    await pay(o.id, 1000);
    assert.equal((await view(o.id)).version, o.version);
  });

  it("overpayment is rejected and nothing is written", async () => {
    const o = await placed();
    const e = await rejectsWith(() => pay(o.id, TOTAL + 1), "CONFLICT", "OVERPAYMENT");
    assert.equal(e.details.outstandingPaise, TOTAL);
    await pay(o.id, TOTAL - 100);
    const e2 = await rejectsWith(() => pay(o.id, 101), "CONFLICT", "OVERPAYMENT");
    assert.equal(e2.details.outstandingPaise, 100);
    await rejectsWith(() => pay(o.id, TOTAL), "CONFLICT", "OVERPAYMENT");
    assert.equal(await call((s) => count(s, "select count(*) as n from payments where order_id = $1", [o.id])), 1);
    await pay(o.id, 100);
    await rejectsWith(() => pay(o.id, 1), "CONFLICT", "OVERPAYMENT");
  });

  it("only live orders take payments: not a draft, cancelled or rejected order", async () => {
    const d = await call((s) => createOrderDraft(s, ctx(), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] }));
    await rejectsWith(() => pay(d.id, 100), "INVALID_TRANSITION", "ORDER_INVALID_STATE");
    const c = await placed();
    await call((s) => cancelOrder(s, ctx(), { orderId: c.id }));
    await rejectsWith(() => pay(c.id, 100), "INVALID_TRANSITION", "ORDER_INVALID_STATE");
    const r = await placed();
    await call((s) => rejectOrder(s, ctx(), { orderId: r.id, expectedVersion: r.version }));
    await rejectsWith(() => pay(r.id, 100), "INVALID_TRANSITION", "ORDER_INVALID_STATE");
    const f = await fulfilled();
    assert.equal((await pay(f.id, 100)).order.paymentStatus, "partial");
  });

  it("rejects bad amounts, unknown keys and a smuggled kind/status/tenant", async () => {
    const o = await placed();
    const bad = (extra: Record<string, unknown>) => rejectsWith(() => call((s) => recordPayment(s, ctx(), { orderId: o.id, amountPaise: 100, method: "cash", ...extra } as never)), "VALIDATION_FAILED");
    for (const amountPaise of [0, -1, 1.5, 1e13, Number.NaN, "100", null]) await bad({ amountPaise });
    await bad({ method: "bitcoin" });
    await bad({ kind: "refund" });
    await bad({ status: "pending" });
    await bad({ tenantId: fx.tenantId });
    await bad({ currency: "USD" });
    await bad({ provider: "razorpay" });
    await bad({ orderId: "x" });
    assert.equal(await call((s) => count(s, "select count(*) as n from payments where order_id = $1", [o.id])), 0);
  });

  it("a provider reference can be recorded once", async () => {
    const a = await placed();
    const b = await placed();
    const input = { amountPaise: 500, method: "upi" as const, provider: "upi-app", providerReference: `ref-${randomUUID()}` };
    await call((s) => recordPayment(s, ctx(), { orderId: a.id, ...input }));
    await rejectsWith(() => call((s) => recordPayment(s, ctx(), { orderId: b.id, ...input })), "CONFLICT", "DUPLICATE");
  });
});

describe("recordRefund", () => {
  it("a refund cannot exceed what is held", async () => {
    const o = await placed();
    const e = await rejectsWith(() => refund(o.id, 1), "CONFLICT", "REFUND_EXCEEDS_PAID");
    assert.equal(e.details.refundablePaise, 0);
    await pay(o.id, 3000);
    await rejectsWith(() => refund(o.id, 3001), "CONFLICT", "REFUND_EXCEEDS_PAID");
    const r = await refund(o.id, 1000);
    assert.equal(r.payment.kind, "refund");
    assert.equal(r.order.payment.netPaidPaise, 2000);
    await rejectsWith(() => refund(o.id, 2001), "CONFLICT", "REFUND_EXCEEDS_PAID");
    await refund(o.id, 2000);
    await rejectsWith(() => refund(o.id, 1), "CONFLICT", "REFUND_EXCEEDS_PAID");
  });

  it("partial refund of a paid order makes it partial; refunding everything makes it refunded", async () => {
    const o = await placed();
    await pay(o.id, TOTAL);
    const half = await refund(o.id, 5000);
    assert.equal(half.order.paymentStatus, "partial");
    assert.equal(half.order.payment.outstandingPaise, 5000);
    const all = await refund(o.id, 5500);
    assert.equal(all.order.paymentStatus, "refunded");
    assert.equal(all.order.status, "PLACED", "an order that is not fulfilled stays where it is");
    assert.equal(all.order.version, o.version, "ledger entries leave the version alone");
  });

  it("after a partial refund the customer can pay the difference, but not more", async () => {
    const o = await placed();
    await pay(o.id, TOTAL);
    await refund(o.id, 2000);
    await rejectsWith(() => pay(o.id, 2001), "CONFLICT", "OVERPAYMENT");
    const r = await pay(o.id, 2000);
    assert.equal(r.order.paymentStatus, "paid");
    assert.equal(r.order.payment.paidPaise, TOTAL + 2000);
    assert.equal(r.order.payment.netPaidPaise, TOTAL);
  });

  it("a fully refunded FULFILLED order moves to REFUNDED (version +1); a partial refund does not", async () => {
    const f = await fulfilled();
    await pay(f.id, TOTAL);
    const part = await refund(f.id, 500);
    assert.equal(part.order.status, "FULFILLED");
    assert.equal(part.order.version, f.version);
    const full = await refund(f.id, TOTAL - 500);
    assert.equal(full.order.status, "REFUNDED");
    assert.equal(full.order.statusLabel, "Refunded");
    assert.equal(full.order.paymentStatus, "refunded");
    assert.equal(full.order.version, f.version + 1);
    assert.deepEqual(full.order.allowedNext, []);
    await rejectsWith(() => pay(f.id, 100), "INVALID_TRANSITION", "ORDER_INVALID_STATE");
    await rejectsWith(() => refund(f.id, 1), "CONFLICT", "REFUND_EXCEEDS_PAID");
    const audit = await call((s) => s.query("select action from audit_log where tenant_id = $1 and entity_id = $2 and action = 'order.refunded'", [fx.tenantId, f.id]));
    assert.equal(audit.rows.length, 1);
  });

  it("REFUNDED is reachable only from FULFILLED: a paid READY order refunded in full is not REFUNDED", async () => {
    let o = await placed();
    for (const fn of [acceptOrder, startProcessing, markReady]) o = await call((s) => fn(s, ctx(), { orderId: o.id, expectedVersion: o.version }));
    await pay(o.id, TOTAL);
    const r = await refund(o.id, TOTAL);
    assert.equal(r.order.status, "READY");
    assert.equal(r.order.paymentStatus, "refunded");
    await rejectsWith(() => call((s) => transitionOrder(s, ctx(), { orderId: o.id, to: "REFUNDED", expectedVersion: r.order.version })), "INVALID_TRANSITION");
  });

  it("transitionOrder to REFUNDED needs the ledger fully refunded first", async () => {
    const f = await fulfilled();
    await rejectsWith(() => call((s) => transitionOrder(s, ctx(), { orderId: f.id, to: "REFUNDED", expectedVersion: f.version })), "CONFLICT", "REFUND_REQUIRED");
    await pay(f.id, 3000);
    await rejectsWith(() => call((s) => transitionOrder(s, ctx(), { orderId: f.id, to: "REFUNDED", expectedVersion: f.version })), "CONFLICT", "REFUND_REQUIRED");
    assert.equal((await view(f.id)).status, "FULFILLED");
  });

  it("when the pack removed FULFILLED -> REFUNDED, a full refund leaves the order FULFILLED with payment_status refunded", async () => {
    const base = registryPackFor("restaurant");
    const narrowed = { ...base, orderTransitions: { ...base.orderTransitions, transitions: { ...base.orderTransitions.transitions, FULFILLED: [] } } };
    setPackResolver((id) => (id === "restaurant-no-refunded" ? (narrowed as typeof base) : registryPackFor(id)));
    try {
      const n = await restaurantFixture(db, "restaurant-no-refunded");
      const c = ctxFor(n.tenantId);
      const run = <T>(fn: (s: Client) => Promise<T>) => tx(db, n.tenantId, fn);
      let o = await run((s) => createOrderDraft(s, c, { items: [{ catalogueItemId: n.tikka, quantity: 1 }], customerId: n.customerId }));
      o = await run((s) => placeOrder(s, c, { orderId: o.id }));
      for (const fn of [acceptOrder, startProcessing, markReady, fulfil]) o = await run((s) => fn(s, c, { orderId: o.id, expectedVersion: o.version }));
      await run((s) => recordPayment(s, c, { orderId: o.id, amountPaise: o.totalPaise, method: "cash" }));
      const r = await run((s) => recordRefund(s, c, { orderId: o.id, amountPaise: o.totalPaise, method: "cash" }));
      assert.equal(r.order.status, "FULFILLED");
      assert.equal(r.order.paymentStatus, "refunded");
    } finally {
      setPackResolver(null);
    }
  });

  it("refunds on a draft are refused", async () => {
    const d = await call((s) => createOrderDraft(s, ctx(), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }] }));
    await rejectsWith(() => refund(d.id, 100), "INVALID_TRANSITION", "ORDER_INVALID_STATE");
  });

  it("rejects a smuggled kind, tenant or status on a refund", async () => {
    const o = await placed();
    await pay(o.id, 1000);
    for (const extra of [{ kind: "payment" }, { tenantId: fx.tenantId }, { status: "completed" }, { provider: "x" }]) {
      await rejectsWith(() => call((s) => recordRefund(s, ctx(), { orderId: o.id, amountPaise: 100, method: "cash", ...extra } as never)), "VALIDATION_FAILED");
    }
  });
});

describe("ledger is insert-only for the application role", () => {
  it("amounts cannot be changed or entries deleted", async () => {
    const o = await placed();
    const r = await pay(o.id, 1000);
    const attempt = (sql: string) => call((s) => s.query(sql, [r.payment.id])).then(() => "ok", (e: { code?: string }) => e.code);
    assert.equal(await attempt("update payments set amount_paise = 1 where id = $1"), "42501");
    assert.equal(await attempt("update payments set kind = 'refund' where id = $1"), "42501");
    assert.equal(await attempt("update payments set order_id = null where id = $1"), "42501");
    assert.equal(await attempt("delete from payments where id = $1"), "42501");
    assert.equal((await view(o.id)).payment.paidPaise, 1000);
  });
});

describe("idempotent ledger writes", () => {
  it("the same key records one payment and replays it", async () => {
    const o = await placed();
    const c = ctx({ idempotencyKey: `pay-${randomUUID()}` });
    const a = await pay(o.id, 2000, c);
    const b = await pay(o.id, 2000, c);
    assert.equal(a.payment.id, b.payment.id);
    assert.equal(b.order.payment.paidPaise, 2000);
    assert.equal(await call((s) => count(s, "select count(*) as n from payments where order_id = $1", [o.id])), 1);
    await rejectsWith(() => pay(o.id, 2001, c), "IDEMPOTENCY_CONFLICT");
  });

  it("10 concurrent duplicates with one key: one entry, one event", async () => {
    const o = await placed();
    const c = ctx({ idempotencyKey: `pay-${randomUUID()}` });
    const results = await Promise.all(Array.from({ length: 10 }, () => pay(o.id, 1500, c)));
    assert.equal(new Set(results.map((r) => r.payment.id)).size, 1);
    assert.equal(await call((s) => count(s, "select count(*) as n from payments where order_id = $1", [o.id])), 1);
    assert.equal(await call((s) => count(s, "select count(*) as n from outbox_events where tenant_id = $1 and type = 'payment.completed' and aggregate_id = $2", [fx.tenantId, results[0]!.payment.id])), 1);
  });

  it("a refund key replays too", async () => {
    const o = await placed();
    await pay(o.id, 3000);
    const c = ctx({ idempotencyKey: `ref-${randomUUID()}` });
    const a = await refund(o.id, 1000, c);
    const b = await refund(o.id, 1000, c);
    assert.equal(a.payment.id, b.payment.id);
    assert.equal((await view(o.id)).payment.refundedPaise, 1000);
  });
});

describe("concurrency: the ledger cannot be overdrawn", () => {
  it("30 parallel payments of 1000 against 10500 outstanding: exactly 10 succeed", async () => {
    const o = await placed();
    const settled = await Promise.allSettled(Array.from({ length: 30 }, () => pay(o.id, 1000)));
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    const bad = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok, 10);
    for (const b of bad) assert.equal((b.reason as { details: { reason: string } }).details.reason, "OVERPAYMENT");
    const v = await view(o.id);
    assert.equal(v.payment.paidPaise, 10000);
    assert.equal(v.payment.outstandingPaise, 500);
    assert.equal(v.paymentStatus, "partial");
  });

  it("30 parallel refunds of 1000 against 10500 held: exactly 10 succeed, the rest are over-refunds", async () => {
    const o = await placed();
    await pay(o.id, TOTAL);
    const settled = await Promise.allSettled(Array.from({ length: 30 }, () => refund(o.id, 1000)));
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 10);
    for (const b of settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[]) {
      assert.equal((b.reason as { details: { reason: string } }).details.reason, "REFUND_EXCEEDS_PAID");
    }
    const v = await view(o.id);
    assert.equal(v.payment.netPaidPaise, 500);
  });

  it("mixed parallel payments and refunds never leave the ledger outside [0, total]", async () => {
    for (let round = 0; round < 4; round++) {
      const o = await placed();
      await pay(o.id, 5000);
      const ops = Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? refund(o.id, 900) : pay(o.id, 700 + (i % 5) * 100)));
      await Promise.allSettled(ops);
      const v = await view(o.id);
      assert.ok(v.payment.netPaidPaise >= 0 && v.payment.netPaidPaise <= v.totalPaise, `round ${round}: net ${v.payment.netPaidPaise}`);
      assert.equal(v.payment.outstandingPaise, v.totalPaise - v.payment.netPaidPaise);
    }
  });

  it("a payment racing a cancel: either the payment lands before and is refunded, or it is refused", async () => {
    for (let round = 0; round < 5; round++) {
      const o = await placed();
      await Promise.allSettled([pay(o.id, 4000), call((s) => cancelOrder(s, ctx(), { orderId: o.id }))]);
      const v = await view(o.id);
      assert.equal(v.status, "CANCELLED");
      assert.equal(v.payment.netPaidPaise, 0, `round ${round}: nothing may stay held on a cancelled order`);
      assert.ok(v.paymentStatus === "unpaid" || v.paymentStatus === "refunded");
    }
  });
});

describe("randomised ledger invariants", () => {
  it("after 300 random valid and invalid operations the stored ledger is consistent", async () => {
    let seed = 424242;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const orders = [await placed(), await placed(), await placed()];
    for (let i = 0; i < 300; i++) {
      const o = orders[Math.floor(rnd() * orders.length)]!;
      const amount = 1 + Math.floor(rnd() * 6000);
      await (rnd() < 0.6 ? pay(o.id, amount) : refund(o.id, amount)).catch(() => undefined);
    }
    for (const o of orders) {
      const v = await view(o.id);
      const rows = await call((s) => s.query<{ kind: string; amount: number }>("select kind, amount_paise::int as amount from payments where order_id = $1 and status = 'completed'", [o.id]));
      const paid = rows.rows.filter((r) => r.kind === "payment").reduce((a, r) => a + r.amount, 0);
      const refunded = rows.rows.filter((r) => r.kind === "refund").reduce((a, r) => a + r.amount, 0);
      assert.ok(refunded <= paid, "refunds never exceed payments");
      assert.ok(paid - refunded <= v.totalPaise, "never more held than the total");
      assert.equal(v.payment.netPaidPaise, paid - refunded);
      const expected = paid === 0 ? "unpaid" : paid - refunded === 0 ? "refunded" : paid - refunded >= v.totalPaise ? "paid" : "partial";
      assert.equal(v.paymentStatus, expected);
    }
  });
});

describe("listing and filters", () => {
  it("listOrders filters by payment status", async () => {
    const o = await placed();
    await pay(o.id, TOTAL);
    const paid = await call((s) => listOrders(s, ctx(), { paymentStatus: "paid", limit: 100 }));
    assert.ok(paid.items.some((i) => i.id === o.id));
    assert.ok(paid.items.every((i) => i.paymentStatus === "paid"));
  });

  it("listPayments on an unknown order is NOT_FOUND", async () => {
    await rejectsWith(() => call((s) => listPayments(s, ctx(), { orderId: randomUUID() })), "NOT_FOUND", "ORDER_NOT_FOUND");
  });
});
