import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RoundingMode as R,
  addPaise,
  addTax,
  applyDiscount,
  divideRound,
  formatPaise,
  multiplyPaise,
  parsePaise,
  parsePaiseOrThrow,
  parsePercentToBps,
  percentOf,
  splitPaise,
  subtractPaise,
  sumPaise,
} from "../src/index.ts";

// Deterministic PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const int = (next: () => number, lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));

test("add, subtract, sum are exact and reject non-integers", () => {
  assert.equal(addPaise(1, 2, 3), 6);
  assert.equal(subtractPaise(10, 25), -15);
  assert.equal(sumPaise([]), 0);
  assert.equal(sumPaise([10, 20, 30]), 60);
  assert.throws(() => addPaise(0.1, 0.2), RangeError);
  assert.throws(() => addPaise(Number.NaN), RangeError);
  assert.throws(() => addPaise(Number.MAX_SAFE_INTEGER, 1), RangeError);
  assert.throws(() => multiplyPaise(100, 1.5), RangeError);
});

test("property: addition is commutative and associative", () => {
  const next = rng(1);
  for (let i = 0; i < 500; i++) {
    const [a, b, c] = [int(next, -1e9, 1e9), int(next, -1e9, 1e9), int(next, -1e9, 1e9)] as [number, number, number];
    assert.equal(addPaise(a, b), addPaise(b, a));
    assert.equal(addPaise(addPaise(a, b), c), addPaise(a, addPaise(b, c)));
    assert.equal(subtractPaise(addPaise(a, b), b), a);
  }
});

test("multiply by quantity", () => {
  assert.equal(multiplyPaise(12_550, 3), 37_650);
  assert.equal(multiplyPaise(12_550, 0), 0);
  assert.equal(multiplyPaise(0, 999), 0);
  assert.throws(() => multiplyPaise(Number.MAX_SAFE_INTEGER, 2), RangeError);
});

test("property: multiply equals repeated addition", () => {
  const next = rng(2);
  for (let i = 0; i < 200; i++) {
    const price = int(next, 0, 500_000);
    const qty = int(next, 0, 40);
    assert.equal(multiplyPaise(price, qty), sumPaise(Array.from({ length: qty }, () => price)));
  }
});

test("rounding: ties at exactly half a paise for every mode", () => {
  // 5% of 10 paise = 0.5 paise
  assert.equal(percentOf(10, 500, R.HALF_UP), 1);
  assert.equal(percentOf(10, 500, R.HALF_EVEN), 0);
  assert.equal(percentOf(10, 500, R.FLOOR), 0);
  assert.equal(percentOf(10, 500, R.CEIL), 1);
  assert.equal(percentOf(10, 500, R.TRUNC), 0);
  // 15% of 10 paise = 1.5 paise
  assert.equal(percentOf(10, 1500, R.HALF_UP), 2);
  assert.equal(percentOf(10, 1500, R.HALF_EVEN), 2);
  assert.equal(percentOf(10, 1500, R.FLOOR), 1);
  assert.equal(percentOf(10, 1500, R.CEIL), 2);
  assert.equal(percentOf(10, 1500, R.TRUNC), 1);
  // 25 paise * 10% = 2.5 -> half-even gives 2, half-up gives 3
  assert.equal(percentOf(25, 1000, R.HALF_EVEN), 2);
  assert.equal(percentOf(25, 1000, R.HALF_UP), 3);
});

test("rounding: negative values", () => {
  // -0.5 -> HALF_UP is away from zero, FLOOR to -1, CEIL to 0, TRUNC to 0
  assert.equal(percentOf(-10, 500, R.HALF_UP), -1);
  assert.equal(percentOf(-10, 500, R.HALF_EVEN), 0);
  assert.equal(percentOf(-10, 500, R.FLOOR), -1);
  assert.equal(percentOf(-10, 500, R.CEIL), 0);
  assert.equal(percentOf(-10, 500, R.TRUNC), 0);
  // -1.5
  assert.equal(percentOf(-10, 1500, R.HALF_UP), -2);
  assert.equal(percentOf(-10, 1500, R.HALF_EVEN), -2);
  assert.equal(percentOf(-10, 1500, R.FLOOR), -2);
  assert.equal(percentOf(-10, 1500, R.CEIL), -1);
  // -2.5 half even -> -2
  assert.equal(percentOf(-25, 1000, R.HALF_EVEN), -2);
});

test("rounding: just below and just above a tie", () => {
  // 1% of 49 = 0.49 ; of 50 = 0.5 ; of 51 = 0.51
  assert.equal(percentOf(49, 100, R.HALF_UP), 0);
  assert.equal(percentOf(50, 100, R.HALF_UP), 1);
  assert.equal(percentOf(51, 100, R.HALF_UP), 1);
  assert.equal(percentOf(49, 100, R.CEIL), 1);
  assert.equal(percentOf(51, 100, R.FLOOR), 0);
});

test("rounding: zero rate, zero amount, full rate, exact results", () => {
  for (const mode of Object.values(R)) {
    assert.equal(percentOf(12_345, 0, mode), 0);
    assert.equal(percentOf(0, 1800, mode), 0);
    assert.equal(percentOf(12_345, 10_000, mode), 12_345);
    assert.equal(percentOf(10_000, 1800, mode), 1800);
  }
});

test("property: rounding modes are ordered and within one paise of exact", () => {
  const next = rng(3);
  for (let i = 0; i < 2000; i++) {
    const amount = int(next, -10_000_000, 10_000_000);
    const bps = int(next, 0, 10_000);
    const floor = percentOf(amount, bps, R.FLOOR);
    const ceil = percentOf(amount, bps, R.CEIL);
    const trunc = percentOf(amount, bps, R.TRUNC);
    const up = percentOf(amount, bps, R.HALF_UP);
    const even = percentOf(amount, bps, R.HALF_EVEN);
    assert.ok(floor <= up && up <= ceil);
    assert.ok(floor <= even && even <= ceil);
    assert.ok(ceil - floor <= 1);
    assert.ok(trunc === floor || trunc === ceil);
    // exact value comparison without floats: |2*rounded*10000 - 2*amount*bps| <= 10000
    const exact2 = 2n * BigInt(amount) * BigInt(bps);
    for (const r of [up, even]) {
      const diff = 2n * BigInt(r) * 10_000n - exact2;
      assert.ok((diff < 0n ? -diff : diff) <= 10_000n);
    }
  }
});

test("divideRound rejects non-positive divisor", () => {
  assert.throws(() => divideRound(1n, 0n, R.HALF_UP), RangeError);
  assert.throws(() => divideRound(1n, -2n, R.HALF_UP), RangeError);
});

test("percentOf avoids float error that Number math would show", () => {
  // 0.1 + 0.2 style trap: 1.15 * 100 in floats is 114.99999999999999
  assert.equal(percentOf(10_000, 1150, R.HALF_UP), 1150);
  // large amounts stay exact: 9e15 paise at 18%
  assert.equal(percentOf(9_000_000_000_000_000, 1800, R.HALF_UP), 1_620_000_000_000_000);
});

test("addTax and applyDiscount", () => {
  assert.deepEqual(addTax(100_000, 1800, R.HALF_UP), { taxPaise: 18_000, totalPaise: 118_000 });
  // 18% of 99.99 = 17.9982 -> 17.99 (HALF_UP) ; CEIL 18.00
  assert.deepEqual(addTax(9999, 1800, R.HALF_UP), { taxPaise: 1800, totalPaise: 11_799 });
  assert.deepEqual(addTax(9999, 1800, R.FLOOR), { taxPaise: 1799, totalPaise: 11_798 });
  assert.throws(() => addTax(100, -1, R.HALF_UP), RangeError);
  assert.deepEqual(applyDiscount(50_000, 1000, R.HALF_UP), { discountPaise: 5000, totalPaise: 45_000 });
  assert.deepEqual(applyDiscount(999, 5000, R.HALF_UP), { discountPaise: 500, totalPaise: 499 });
  assert.deepEqual(applyDiscount(999, 5000, R.FLOOR), { discountPaise: 499, totalPaise: 500 });
  assert.deepEqual(applyDiscount(1234, 10_000, R.HALF_UP), { discountPaise: 1234, totalPaise: 0 });
  assert.throws(() => applyDiscount(100, 10_001, R.HALF_UP), RangeError);
});

test("property: discount never exceeds a non-negative amount", () => {
  const next = rng(4);
  for (let i = 0; i < 1000; i++) {
    const amount = int(next, 0, 5_000_000);
    const bps = int(next, 0, 10_000);
    for (const mode of Object.values(R)) {
      const { discountPaise, totalPaise } = applyDiscount(amount, bps, mode);
      assert.ok(discountPaise >= 0 && discountPaise <= amount);
      assert.equal(discountPaise + totalPaise, amount);
    }
  }
});

test("splitPaise sums exactly and spreads the remainder", () => {
  assert.deepEqual(splitPaise(100, 3), [34, 33, 33]);
  assert.deepEqual(splitPaise(0, 4), [0, 0, 0, 0]);
  assert.deepEqual(splitPaise(2, 5), [1, 1, 0, 0, 0]);
  assert.deepEqual(splitPaise(-100, 3), [-33, -33, -34]);
  assert.throws(() => splitPaise(100, 0), RangeError);
  const next = rng(5);
  for (let i = 0; i < 300; i++) {
    const amount = int(next, -1_000_000, 1_000_000);
    const parts = int(next, 1, 12);
    const out = splitPaise(amount, parts);
    assert.equal(out.length, parts);
    assert.equal(sumPaise(out), amount);
    assert.ok(Math.max(...out) - Math.min(...out) <= 1);
  }
});

test("format for display", () => {
  assert.equal(formatPaise(123_450), "₹1,234.50");
  assert.equal(formatPaise(0), "₹0.00");
  assert.equal(formatPaise(5), "₹0.05");
  assert.equal(formatPaise(100), "₹1.00");
  assert.equal(formatPaise(99_999), "₹999.99");
  assert.equal(formatPaise(100_000), "₹1,000.00");
  assert.equal(formatPaise(123_456_789), "₹12,34,567.89");
  assert.equal(formatPaise(1_000_000_000), "₹1,00,00,000.00");
  assert.equal(formatPaise(-123_450), "-₹1,234.50");
  assert.equal(formatPaise(-5), "-₹0.05");
  assert.equal(formatPaise(123_450, { symbol: false }), "1,234.50");
  assert.equal(formatPaise(120_000, { alwaysDecimals: false }), "₹1,200");
  assert.equal(formatPaise(120_050, { alwaysDecimals: false }), "₹1,200.50");
  assert.throws(() => formatPaise(1.5), RangeError);
});

test("parse from decimal string", () => {
  assert.equal(parsePaise("1234.50"), 123_450);
  assert.equal(parsePaise("1234.5"), 123_450);
  assert.equal(parsePaise("1234"), 123_400);
  assert.equal(parsePaise("0.05"), 5);
  assert.equal(parsePaise("0"), 0);
  assert.equal(parsePaise(" 10 "), 1000);
  assert.equal(parsePaise("-10.25"), -1025);
  assert.equal(parsePaise("₹1,234.50"), 123_450);
  assert.equal(parsePaise("₹12,34,567.89"), 123_456_789);
  assert.equal(parsePaise("1,234,567.00"), 123_456_700);
  assert.equal(parsePaise("-₹5"), -500);
  assert.equal(parsePaiseOrThrow("19.99"), 1999);
});

test("parse rejects instead of rounding or guessing", () => {
  for (const bad of ["", "abc", "1.234", "1.", ".5", "1e3", "1,23", "12,34", "1,2345.00", "--5", "5-", "1 000", "NaN", "Infinity", "0x10", "1..2"]) {
    assert.equal(parsePaise(bad), null, bad);
  }
  assert.equal(parsePaise("99999999999999999999"), null);
  assert.throws(() => parsePaiseOrThrow("1.234"), RangeError);
});

test("property: parse(format(x)) round trips", () => {
  const next = rng(6);
  for (let i = 0; i < 1000; i++) {
    const v = int(next, -2_000_000_000, 2_000_000_000);
    assert.equal(parsePaise(formatPaise(v)), v);
    assert.equal(parsePaise(formatPaise(v, { symbol: false })), v);
  }
  for (const v of [0, 1, 99, 100, 999, 1000, 99_999, 100_000, 9_999_999, 10_000_000, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
    assert.equal(parsePaise(formatPaise(v)), v);
  }
});

test("percent strings to basis points", () => {
  assert.equal(parsePercentToBps("18"), 1800);
  assert.equal(parsePercentToBps("12.5"), 1250);
  assert.equal(parsePercentToBps("0.25"), 25);
  assert.equal(parsePercentToBps("100"), 10_000);
  assert.equal(parsePercentToBps("1.234"), null);
  assert.equal(parsePercentToBps("-5"), null);
  assert.equal(parsePercentToBps("x"), null);
});
