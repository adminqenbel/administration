/**
 * Money columns are bigint (integer paise). node-postgres returns bigint as a string, so convert explicitly
 * and fail loudly rather than lose precision: @qenbel/shared money values are JS numbers that must be safe integers.
 */
export function toPaise(value: string | number | bigint | null | undefined): number {
  if (value === null || value === undefined) throw new TypeError("toPaise: null amount");
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`toPaise: ${String(value)} is not a safe integer amount of paise`);
  return n;
}
