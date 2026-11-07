// Pure tests (no database): totals, rounding, discount allocation, ledger status. Property-style cases use a seeded
// PRNG so a failure is reproducible, and compare against an independent BigInt reference.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoundingMode } from "@qenbel/shared";
import {
  ORDER_ROUNDING_MODE,
  allocateProportionally,
  computeTotals,
  discountAmount,
  discountBpsOfSubtotal,
  type DiscountSpec,
  type TotalsLineInput,
} from "../src/totals.ts";
import { derivePaymentStatus, netPaidPaise, outstandingPaise } from "../src/ledger.ts";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

/** Independent reference: n/d rounded half away from zero, for non-negative n. */
const halfUp = (n: bigint, d: bigint): bigint => (2n * n + d) / (2n * d);

function randomLines(r: () => number): TotalsLineInput[] {
  const n = int(r, 1, 8);
  return Array.from({ length: n }, () => ({
    quantity: int(r, 1, 999),
    unitPricePaise: r() < 0.1 ? 0 : int(r, 1, 5_000_000),
    taxRateBps: [0, 100, 250, 500, 1200, 1800, 2800, 10000, int(r, 0, 10000)][int(r, 0, 8)] as number,
  }));
}

describe("computeTotals: fixed cases", () => {
  it("no discount, mixed tax rates", () => {
    const t = computeTotals(
      [
        { quantity: 2, unitPricePaise: 10000, taxRateBps: 500 }, // 20000 + 1000
        { quantity: 1, unitPricePaise: 4950, taxRateBps: 1800 }, // 4950 + 891
        { quantity: 3, unitPricePaise: 100, taxRateBps: 0 }, // 300
      ],
      null,
    );
    assert.equal(t.subtotalPaise, 25250);
    assert.equal(t.taxPaise, 1891);
    assert.equal(t.discountPaise, 0);
    assert.equal(t.totalPaise, 27141);
    assert.deepEqual(t.lines.map((l) => l.taxPaise), [1000, 891, 0]);
  });

  it("the default rounding mode is HALF_UP and is explicit", () => {
    assert.equal(ORDER_ROUNDING_MODE, RoundingMode.HALF_UP);
  });

  it("tax rounding: ties go up, below a tie goes down", () => {
    // 5% of 10 paise = 0.5 -> 1;  5% of 9 = 0.45 -> 0;  5% of 11 = 0.55 -> 1
    for (const [price, tax] of [[10, 1], [9, 0], [11, 1], [30, 2], [29, 1]] as const) {
      assert.equal(computeTotals([{ quantity: 1, unitPricePaise: price, taxRateBps: 500 }], null).taxPaise, tax, `5% of ${price}`);
    }
  });

  it("an explicit mode changes only the ties (HALF_EVEN vs HALF_UP)", () => {
    const line = [{ quantity: 1, unitPricePaise: 25, taxRateBps: 1000 }]; // 2.5
    assert.equal(computeTotals(line, null, RoundingMode.HALF_UP).taxPaise, 3);
    assert.equal(computeTotals(line, null, RoundingMode.HALF_EVEN).taxPaise, 2);
    assert.equal(computeTotals(line, null, RoundingMode.FLOOR).taxPaise, 2);
    assert.equal(computeTotals(line, null, RoundingMode.CEIL).taxPaise, 3);
  });

  it("tax is charged on the discounted value", () => {
    // 100.00 at 18% with a flat 10.00 discount: taxable 90.00, tax 16.20, total 106.20
    const t = computeTotals([{ quantity: 1, unitPricePaise: 10000, taxRateBps: 1800 }], { kind: "fixed", amountPaise: 1000 });
    assert.equal(t.taxPaise, 1620);
    assert.equal(t.totalPaise, 10000 - 1000 + 1620);
  });

  it("percent discount rounds with the mode: 10% of 3335 = 333.5 -> 334, of 3333 -> 333", () => {
    const d = (price: number) => computeTotals([{ quantity: 1, unitPricePaise: price, taxRateBps: 0 }], { kind: "percent", bps: 1000 }).discountPaise;
    assert.equal(d(3335), 334);
    assert.equal(d(3333), 333);
  });

  it("a discount is spread over lines and the parts sum exactly", () => {
    const t = computeTotals(
      [
        { quantity: 1, unitPricePaise: 1, taxRateBps: 0 },
        { quantity: 1, unitPricePaise: 1, taxRateBps: 0 },
        { quantity: 1, unitPricePaise: 1, taxRateBps: 0 },
      ],
      { kind: "fixed", amountPaise: 2 },
    );
    assert.equal(t.lines.reduce((a, l) => a + l.discountSharePaise, 0), 2);
    assert.deepEqual(t.lines.map((l) => l.discountSharePaise), [1, 1, 0]); // ties: earlier line first
  });

  it("100% discount leaves nothing to pay or tax", () => {
    const t = computeTotals([{ quantity: 3, unitPricePaise: 777, taxRateBps: 1800 }], { kind: "percent", bps: 10000 });
    assert.equal(t.totalPaise, 0);
    assert.equal(t.taxPaise, 0);
    assert.equal(t.discountPaise, 2331);
  });

  it("an empty order and a zero-price order are valid and total zero", () => {
    assert.equal(computeTotals([], null).totalPaise, 0);
    assert.equal(computeTotals([{ quantity: 5, unitPricePaise: 0, taxRateBps: 1800 }], null).totalPaise, 0);
  });

  it("rejects a discount above the subtotal, a negative or fractional one, and a bad rate", () => {
    const line = [{ quantity: 1, unitPricePaise: 1000, taxRateBps: 0 }];
    assert.throws(() => computeTotals(line, { kind: "fixed", amountPaise: 1001 }), RangeError);
    assert.throws(() => computeTotals(line, { kind: "fixed", amountPaise: -1 }), RangeError);
    assert.throws(() => computeTotals(line, { kind: "fixed", amountPaise: 1.5 }), RangeError);
    assert.throws(() => computeTotals(line, { kind: "percent", bps: 10001 }), RangeError);
    assert.throws(() => computeTotals(line, { kind: "percent", bps: -1 }), RangeError);
    assert.throws(() => computeTotals([{ quantity: 1, unitPricePaise: 1000, taxRateBps: 10001 }], null), RangeError);
    assert.throws(() => computeTotals([{ quantity: 0, unitPricePaise: 1000, taxRateBps: 0 }], null), RangeError);
    assert.throws(() => computeTotals([{ quantity: 1, unitPricePaise: 10.5, taxRateBps: 0 }], null), RangeError);
  });

  it("a total above the engine cap or the safe-integer range is refused, not wrapped", () => {
    assert.throws(() => computeTotals([{ quantity: 999, unitPricePaise: 2_000_000_000, taxRateBps: 0 }], null), RangeError);
    assert.throws(() => computeTotals([{ quantity: 999, unitPricePaise: Number.MAX_SAFE_INTEGER, taxRateBps: 0 }], null), RangeError);
  });

  it("discountBpsOfSubtotal rounds up (conservative for the cap check)", () => {
    assert.equal(discountBpsOfSubtotal(1, 3), 3334);
    assert.equal(discountBpsOfSubtotal(0, 0), 0);
    assert.equal(discountBpsOfSubtotal(2000, 10000), 2000);
    assert.equal(discountBpsOfSubtotal(2001, 10000), 2001);
  });
});

describe("computeTotals: properties (seeded random, vs a BigInt reference)", () => {
  it("2000 random orders: invariants hold and match the reference", () => {
    const r = rng(20261107);
    for (let i = 0; i < 2000; i++) {
      const lines = randomLines(r);
      const subtotalRef = lines.reduce((a, l) => a + BigInt(l.quantity) * BigInt(l.unitPricePaise), 0n);
      const kind = r();
      let discount: DiscountSpec | null = null;
      if (kind < 0.35) discount = { kind: "percent", bps: int(r, 0, 10000) };
      else if (kind < 0.7) discount = { kind: "fixed", amountPaise: Number(subtotalRef === 0n ? 0n : BigInt(Math.floor(r() * Number(subtotalRef > 9_000_000_000n ? 9_000_000_000n : subtotalRef)))) };
      const t = computeTotals(lines, discount);
      const tag = `case ${i} ${JSON.stringify({ lines, discount })}`;

      assert.equal(BigInt(t.subtotalPaise), subtotalRef, tag);
      const discountRef = discount === null ? 0n : discount.kind === "fixed" ? BigInt(discount.amountPaise) : halfUp(subtotalRef * BigInt(discount.bps), 10000n);
      assert.equal(BigInt(t.discountPaise), discountRef, tag);

      // shares: exact sum, each within [0, net]
      assert.equal(t.lines.reduce((a, l) => a + l.discountSharePaise, 0), t.discountPaise, tag);
      t.lines.forEach((l, idx) => {
        assert.ok(l.discountSharePaise >= 0 && l.discountSharePaise <= l.lineNetPaise, tag);
        assert.equal(l.taxablePaise, l.lineNetPaise - l.discountSharePaise, tag);
        const lineRef = halfUp(BigInt(l.taxablePaise) * BigInt((lines[idx] as TotalsLineInput).taxRateBps), 10000n);
        assert.equal(BigInt(l.taxPaise), lineRef, tag);
      });

      // the database CHECK: total = subtotal + tax - discount, and never negative
      assert.equal(t.totalPaise, t.subtotalPaise + t.taxPaise - t.discountPaise, tag);
      assert.ok(t.totalPaise >= 0, tag);
      assert.equal(t.taxPaise, t.lines.reduce((a, l) => a + l.taxPaise, 0), tag);
      for (const v of [t.subtotalPaise, t.taxPaise, t.discountPaise, t.totalPaise]) assert.ok(Number.isSafeInteger(v), tag);
    }
  });

  it("more percent discount never raises the total (monotonic)", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const lines = randomLines(r);
      let previous = Number.POSITIVE_INFINITY;
      for (const bps of [0, 500, 1000, 2500, 5000, 9999, 10000]) {
        const total = computeTotals(lines, { kind: "percent", bps }).totalPaise;
        // tolerance of one paise per line: line shares use largest remainder, which is not strictly monotone per line
        assert.ok(total <= previous + lines.length, `bps ${bps}: ${total} vs ${previous}`);
        previous = total;
      }
    }
  });

  it("allocateProportionally: exact sum, bounded, deterministic, for random weights", () => {
    const r = rng(99);
    for (let i = 0; i < 1000; i++) {
      const weights = Array.from({ length: int(r, 1, 10) }, () => int(r, 0, 1_000_000));
      const total = weights.reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const amount = int(r, 0, total);
      const shares = allocateProportionally(amount, weights);
      assert.equal(shares.reduce((a, b) => a + b, 0), amount);
      shares.forEach((s, idx) => {
        assert.ok(s >= 0 && s <= (weights[idx] as number));
        // within one paise of the exact proportional share
        const exact = (amount * (weights[idx] as number)) / total;
        assert.ok(Math.abs(s - exact) < 1 + 1e-6, `share ${s} vs ${exact}`);
      });
      assert.deepEqual(allocateProportionally(amount, weights), shares);
    }
    assert.throws(() => allocateProportionally(5, [0, 0]), RangeError);
    assert.deepEqual(allocateProportionally(0, [0, 0]), [0, 0]);
  });

  it("discountAmount refuses to exceed the subtotal", () => {
    assert.equal(discountAmount(500, { kind: "fixed", amountPaise: 500 }), 500);
    assert.throws(() => discountAmount(500, { kind: "fixed", amountPaise: 501 }), RangeError);
  });
});

describe("ledger arithmetic", () => {
  it("derivePaymentStatus", () => {
    const s = (total: number, paid: number, refunded = 0) => derivePaymentStatus(total, { paidPaise: paid, refundedPaise: refunded });
    assert.equal(s(1000, 0), "unpaid");
    assert.equal(s(1000, 400), "partial");
    assert.equal(s(1000, 1000), "paid");
    assert.equal(s(1000, 1000, 1000), "refunded");
    assert.equal(s(1000, 1000, 300), "partial");
    assert.equal(s(1000, 600, 600), "refunded");
    assert.equal(s(0, 0), "unpaid");
  });

  it("net and outstanding are never negative; an inconsistent ledger is refused", () => {
    assert.equal(netPaidPaise({ paidPaise: 500, refundedPaise: 200 }), 300);
    assert.equal(outstandingPaise(1000, { paidPaise: 500, refundedPaise: 200 }), 700);
    assert.equal(outstandingPaise(1000, { paidPaise: 1000, refundedPaise: 0 }), 0);
    assert.equal(outstandingPaise(1000, { paidPaise: 0, refundedPaise: 0 }), 1000);
    assert.throws(() => netPaidPaise({ paidPaise: 100, refundedPaise: 200 }), RangeError);
  });
});
