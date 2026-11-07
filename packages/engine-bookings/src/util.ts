// Small shared helpers: tenant scope guard, database error mapping, canonical JSON, savepoints.
import { createHash } from "node:crypto";
import { AppError, ErrorCode, type EngineContext, type SqlClient } from "@qenbel/shared";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function isoOf(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString();
}

export function isoOrThrow(value: Date | string): string {
  return isoOf(value) as string;
}

/**
 * The SQL client must already be inside `withTenant` for the same tenant as `ctx`. A mismatch is a
 * programming error in the caller, so fail closed before reading or writing anything.
 */
export async function assertScope(sql: SqlClient, ctx: EngineContext): Promise<void> {
  if (typeof ctx.tenantId !== "string" || ctx.tenantId.length === 0) {
    throw new AppError(ErrorCode.TENANT_REQUIRED);
  }
  const res = await sql.query<{ t: string | null }>("select nullif(current_setting('app.tenant_id', true), '') as t");
  const current = res.rows[0]?.t ?? null;
  if (current === null || current.toLowerCase() !== ctx.tenantId.toLowerCase()) {
    throw new AppError(ErrorCode.TENANT_REQUIRED);
  }
}

export function pgCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "constraint" in err) {
    const c = (err as { constraint?: unknown }).constraint;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

/**
 * Translate database errors that have a meaning for callers. Anything unknown is rethrown unchanged
 * (the API turns it into INTERNAL without leaking detail).
 */
export function translateDbError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  switch (pgCode(err)) {
    case "23P01":
      return new AppError(ErrorCode.BOOKING_SLOT_TAKEN, undefined, { reason: "taken" });
    case "23514":
      return new AppError(ErrorCode.VALIDATION_FAILED, undefined, { reason: "check_violation" });
    case "40P01": // deadlock detected
    case "40001": // serialization failure
    case "55P03": // lock not available
      return new AppError(ErrorCode.SERVICE_UNAVAILABLE, undefined, { reason: "retry" });
    default:
      return err;
  }
}

/** Run an engine body and translate known database errors into AppError. */
export async function guarded<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    throw translateDbError(err);
  }
}

let savepointCounter = 0;

/**
 * Run `body` inside a savepoint. If it throws, the savepoint is rolled back, so the transaction stays usable
 * and nothing `body` wrote survives, even if the caller later decides to commit anyway.
 */
export async function withSavepoint<T>(sql: SqlClient, body: () => Promise<T>): Promise<T> {
  const name = `sp_${(savepointCounter = (savepointCounter + 1) % 1_000_000_000)}`;
  await sql.query(`savepoint ${name}`);
  try {
    const result = await body();
    await sql.query(`release savepoint ${name}`);
    return result;
  } catch (err) {
    await sql.query(`rollback to savepoint ${name}`);
    await sql.query(`release savepoint ${name}`);
    throw err;
  }
}

/** JSON with sorted keys, for hashing request bodies. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function toInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new AppError(ErrorCode.INTERNAL);
  return n;
}
