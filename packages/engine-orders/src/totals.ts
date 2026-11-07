// Pure money maths for orders. No database, no clock. Integer paise throughout; every division goes through
// BigInt and an explicit rounding mode from @qenbel/shared.
//
// Rules (documented in README.md):
//   line net      = quantity * unit price                           (exact)
//   subtotal      = sum of line nets
//   discount      = fixed paise, or basis points of the subtotal (rounded with the mode)
//   line discount = the discount spread over the lines in proportion to their net, remainders by the
//                   largest-remainder method (ties: the earlier line), so the parts sum EXACTLY to the discount
//   line tax      = tax rate (bps) applied to the line net AFTER its discount share, rounded with the mode
//   tax           = sum of line taxes
//   total         = subtotal - discount + tax                       (matches the orders_total_consistent CHECK)
// A discount therefore reduces the taxable value, as GST does for a trade discount.
import { DiscountType, RoundingMode, addPaise, divideRound, multiplyPaise, percentOf, type Paise } from "@qenbel/shared";

/** Rounding used for every tax and percentage discount on an order. Explicit, never implicit. */
export const ORDER_ROUNDING_MODE: RoundingMode = RoundingMode.HALF_UP;

/** Largest total the engine will store, in paise (INR 10,000,000,000). Keeps every sum far inside 2^53. */
export const MAX_ORDER_TOTAL_PAISE = 1_000_000_000_000;

export interface TotalsLineInput {
  quantity: number;
  unitPricePaise: Paise;
  /** Tax rate in basis points (1800 = 18%). */
  taxRateBps: number;
}

export type DiscountSpec =
  | { kind: "fixed"; amountPaise: Paise }
  | { kind: "percent"; bps: number };

export interface TotalsLine {
  lineNetPaise: Paise;
  discountSharePaise: Paise;
  taxablePaise: Paise;
  taxPaise: Paise;
}

export interface Totals {
  lines: TotalsLine[];
  subtotalPaise: Paise;
  discountPaise: Paise;
  taxPaise: Paise;
  totalPaise: Paise;
}

/** The discount amount for a subtotal. Throws RangeError when it is not a valid discount. */
export function discountAmount(subtotalPaise: Paise, discount: DiscountSpec | null, mode: RoundingMode = ORDER_ROUNDING_MODE): Paise {
  if (discount === null) return 0;
  let amount: Paise;
  if (discount.kind === "fixed") {
    if (!Number.isSafeInteger(discount.amountPaise) || discount.amountPaise < 0) {
      throw new RangeError("fixed discount must be a non-negative integer number of paise");
    }
    amount = discount.amountPaise;
  } else {
    if (!Number.isSafeInteger(discount.bps) || discount.bps < 0 || discount.bps > 10_000) {
      throw new RangeError("discount rate must be 0 to 10000 bps");
    }
    amount = percentOf(subtotalPaise, discount.bps, mode);
  }
  if (amount > subtotalPaise) throw new RangeError("discount cannot exceed the subtotal");
  return amount;
}

/**
 * Split `amount` across `weights` so the parts sum exactly to `amount`. Largest remainder; ties go to the
 * earlier index. All-zero weights give all zeros (and `amount` must then be 0).
 */
export function allocateProportionally(amount: Paise, weights: readonly Paise[]): Paise[] {
  const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
  if (amount === 0) return weights.map(() => 0);
  if (total === 0n) throw new RangeError("cannot allocate a non-zero amount over zero weights");
  const amt = BigInt(amount);
  const shares: bigint[] = [];
  const remainders: { index: number; rem: bigint }[] = [];
  let assigned = 0n;
  weights.forEach((w, index) => {
    const num = amt * BigInt(w);
    const share = num / total; // weights are non-negative, so this floors
    shares.push(share);
    assigned += share;
    remainders.push({ index, rem: num % total });
  });
  let left = amt - assigned;
  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (const { index } of remainders) {
    if (left === 0n) break;
    shares[index] = (shares[index] as bigint) + 1n;
    left -= 1n;
  }
  return shares.map((s) => Number(s));
}

export function computeTotals(
  lines: readonly TotalsLineInput[],
  discount: DiscountSpec | null,
  mode: RoundingMode = ORDER_ROUNDING_MODE,
): Totals {
  for (const l of lines) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1) throw new RangeError("quantity must be a positive integer");
    if (!Number.isSafeInteger(l.unitPricePaise) || l.unitPricePaise < 0) throw new RangeError("unit price must be a non-negative integer");
    if (!Number.isSafeInteger(l.taxRateBps) || l.taxRateBps < 0 || l.taxRateBps > 10_000) throw new RangeError("tax rate must be 0 to 10000 bps");
  }
  const nets = lines.map((l) => multiplyPaise(l.unitPricePaise, l.quantity));
  const subtotalPaise = addPaise(0, ...nets);
  const discountPaise = discountAmount(subtotalPaise, discount, mode);
  const shares = allocateProportionally(discountPaise, nets);
  const out: TotalsLine[] = lines.map((l, i) => {
    const lineNetPaise = nets[i] as Paise;
    const discountSharePaise = shares[i] as Paise;
    const taxablePaise = lineNetPaise - discountSharePaise;
    const taxPaise = percentOf(taxablePaise, l.taxRateBps, mode);
    return { lineNetPaise, discountSharePaise, taxablePaise, taxPaise };
  });
  const taxPaise = addPaise(0, ...out.map((l) => l.taxPaise));
  const totalPaise = addPaise(subtotalPaise, taxPaise) - discountPaise;
  if (totalPaise > MAX_ORDER_TOTAL_PAISE) throw new RangeError("order total is too large");
  return { lines: out, subtotalPaise, discountPaise, taxPaise, totalPaise };
}

/** Effective discount as basis points of the subtotal (rounded up, so the cap check is conservative). */
export function discountBpsOfSubtotal(discountPaise: Paise, subtotalPaise: Paise): number {
  if (subtotalPaise === 0) return 0;
  return Number(divideRound(BigInt(discountPaise) * 10_000n, BigInt(subtotalPaise), RoundingMode.CEIL));
}

/** Discounts above this share of the subtotal need the override flag (set by the API from a permission). */
export const DISCOUNT_APPROVAL_CAP_BPS = 2_000;

/** The persisted form of a discount spec: `orders.discount_type` + `orders.discount_value`. */
export interface StoredDiscount {
  type: DiscountType;
  /** Paise for `fixed`, basis points for `percent_bps`. */
  value: number;
}

export function specToStored(spec: DiscountSpec): StoredDiscount {
  return spec.kind === "fixed" ? { type: DiscountType.FIXED, value: spec.amountPaise } : { type: DiscountType.PERCENT_BPS, value: spec.bps };
}

export function specFromStored(type: string, value: number): DiscountSpec {
  return type === DiscountType.FIXED ? { kind: "fixed", amountPaise: value } : { kind: "percent", bps: value };
}
