// Money on integer paise. No floats in storage paths: all arithmetic that could
// leave the safe range or needs rounding goes through BigInt.

export const RoundingMode = {
  /** Nearest; ties away from zero. */
  HALF_UP: "HALF_UP",
  /** Nearest; ties to the even neighbour (banker rounding). */
  HALF_EVEN: "HALF_EVEN",
  /** Toward negative infinity. */
  FLOOR: "FLOOR",
  /** Toward positive infinity. */
  CEIL: "CEIL",
  /** Toward zero. */
  TRUNC: "TRUNC",
} as const;
export type RoundingMode = (typeof RoundingMode)[keyof typeof RoundingMode];

export const CURRENCY_DEFAULT = "INR";
/** Basis points in 100%. A rate of 18% is 1800 bps. */
export const BPS_DENOMINATOR = 10_000;

export type Paise = number;

export function isPaise(value: unknown): value is Paise {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function assertPaise(value: unknown, name = "amount"): asserts value is Paise {
  if (!isPaise(value)) throw new RangeError(`${name} must be an integer number of paise`);
}

function fromBig(value: bigint, name: string): Paise {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${name} is outside the safe integer range`);
  }
  return Number(value);
}

/** Divide n by d (d > 0) and round to an integer with an explicit mode. */
export function divideRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d <= 0n) throw new RangeError("divisor must be positive");
  let q = n / d; // truncates toward zero
  const r = n % d; // sign follows n
  if (r === 0n) return q;
  const negative = n < 0n;
  const twiceAbsR = (r < 0n ? -r : r) * 2n;
  switch (mode) {
    case RoundingMode.TRUNC:
      return q;
    case RoundingMode.FLOOR:
      return negative ? q - 1n : q;
    case RoundingMode.CEIL:
      return negative ? q : q + 1n;
    case RoundingMode.HALF_UP:
      if (twiceAbsR >= d) q += negative ? -1n : 1n;
      return q;
    case RoundingMode.HALF_EVEN:
      if (twiceAbsR > d || (twiceAbsR === d && q % 2n !== 0n)) q += negative ? -1n : 1n;
      return q;
    default:
      throw new RangeError("unknown rounding mode");
  }
}

export function addPaise(...amounts: Paise[]): Paise {
  let total = 0n;
  for (const a of amounts) {
    assertPaise(a);
    total += BigInt(a);
  }
  return fromBig(total, "sum");
}

export function subtractPaise(a: Paise, b: Paise): Paise {
  assertPaise(a);
  assertPaise(b);
  return fromBig(BigInt(a) - BigInt(b), "difference");
}

export function sumPaise(amounts: readonly Paise[]): Paise {
  return addPaise(...amounts);
}

/** Unit price times a whole quantity. */
export function multiplyPaise(amount: Paise, quantity: number): Paise {
  assertPaise(amount);
  if (!Number.isSafeInteger(quantity)) throw new RangeError("quantity must be an integer");
  return fromBig(BigInt(amount) * BigInt(quantity), "product");
}

/** `bps` basis points of `amount` (rate 1800 = 18%), rounded with an explicit mode. */
export function percentOf(amount: Paise, bps: number, mode: RoundingMode): Paise {
  assertPaise(amount);
  if (!Number.isSafeInteger(bps)) throw new RangeError("bps must be an integer");
  return fromBig(divideRound(BigInt(amount) * BigInt(bps), BigInt(BPS_DENOMINATOR), mode), "percentage");
}

/** Tax on a net amount. Total = net + tax. */
export function addTax(net: Paise, rateBps: number, mode: RoundingMode): { taxPaise: Paise; totalPaise: Paise } {
  if (rateBps < 0) throw new RangeError("tax rate must not be negative");
  const taxPaise = percentOf(net, rateBps, mode);
  return { taxPaise, totalPaise: addPaise(net, taxPaise) };
}

/** Percentage discount. Rate is 0 to 10000 bps, so the discount never exceeds a positive amount. */
export function applyDiscount(
  amount: Paise,
  rateBps: number,
  mode: RoundingMode,
): { discountPaise: Paise; totalPaise: Paise } {
  if (rateBps < 0 || rateBps > BPS_DENOMINATOR) throw new RangeError("discount rate must be 0 to 10000 bps");
  const discountPaise = percentOf(amount, rateBps, mode);
  return { discountPaise, totalPaise: subtractPaise(amount, discountPaise) };
}

/**
 * Split an amount into n parts that sum exactly to the amount.
 * Earlier parts take the remainder paise.
 */
export function splitPaise(amount: Paise, parts: number): Paise[] {
  assertPaise(amount);
  if (!Number.isSafeInteger(parts) || parts < 1) throw new RangeError("parts must be a positive integer");
  const a = BigInt(amount);
  const p = BigInt(parts);
  const base = divideRound(a, p, RoundingMode.FLOOR);
  let rem = a - base * p;
  const out: Paise[] = [];
  for (let i = 0; i < parts; i++) {
    const extra = rem > 0n ? 1n : 0n;
    rem -= extra;
    out.push(fromBig(base + extra, "part"));
  }
  return out;
}

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) groups.unshift(rest);
  return `${groups.join(",")},${last3}`;
}

export interface FormatOptions {
  /** Default true. Show the currency symbol. */
  symbol?: boolean;
  /** Default true. Show ".00" for whole rupees. */
  alwaysDecimals?: boolean;
}

/** 123450 -> "₹1,234.50". Indian digit grouping (lakh, crore). */
export function formatPaise(amount: Paise, options: FormatOptions = {}): string {
  assertPaise(amount);
  const { symbol = true, alwaysDecimals = true } = options;
  const negative = amount < 0;
  const big = BigInt(amount);
  const abs = big < 0n ? -big : big;
  const rupees = abs / 100n;
  const paise = abs % 100n;
  let text = groupIndian(rupees.toString());
  if (alwaysDecimals || paise !== 0n) text += `.${paise.toString().padStart(2, "0")}`;
  return `${negative ? "-" : ""}${symbol ? "₹" : ""}${text}`;
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;
const GROUPED_INT_RE = /^\d{1,3}(,\d{2})*,\d{3}$|^\d{1,3}(,\d{3})+$/;

/**
 * Parse a decimal rupee string into paise: "1234.5", "₹1,234.50", "-10".
 * More than two decimals is rejected, never rounded. Returns null if invalid.
 */
export function parsePaise(input: string): Paise | null {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^(-?)\s*₹\s*/, "$1");
  if (s.includes(",")) {
    const [intPart = ""] = s.replace(/^-/, "").split(".");
    if (!GROUPED_INT_RE.test(intPart)) return null;
    s = s.replace(/,/g, "");
  }
  const m = DECIMAL_RE.exec(s);
  if (!m) return null;
  const sign = m[1];
  const whole = m[2] ?? "0";
  const frac = m[3] ?? "";
  const value = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0") || "0");
  const signed = sign ? -value : value;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(signed);
}

/** Like parsePaise but throws RangeError. */
export function parsePaiseOrThrow(input: string): Paise {
  const v = parsePaise(input);
  if (v === null) throw new RangeError("not a valid amount");
  return v;
}

/** Parse a percentage string ("18", "12.5", "0.25") to basis points. Max 2 decimals. */
export function parsePercentToBps(input: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bps = BigInt(m[1] as string) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  return bps > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(bps);
}
