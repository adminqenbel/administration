// Engine-level idempotency on the idempotency_keys table. Route is "engine-bookings:<function>", which keeps these rows
// apart from the API's own per-route rows. The row is written in the same transaction as the change, so a key is only
// visible when its result is committed: there is no half-finished state to wait on, and a rolled-back call can be retried.
import { AppError, ErrorCode, idempotencyKeySchema, type EngineContext, type SqlClient } from "@qenbel/shared";
import { canonicalJson, sha256Hex, type Json } from "./util.ts";

interface Stored {
  request_hash: string;
  status: string;
  response_body: Json | null;
}

/**
 * Run `execute` once per (tenant, key, function). With no key on the context it just runs.
 * Same key and same input returns the stored result. Same key and different input is IDEMPOTENCY_CONFLICT.
 */
export async function withIdempotency<T extends object>(
  sql: SqlClient,
  ctx: EngineContext,
  fn: string,
  canonicalInput: unknown,
  execute: () => Promise<T>,
): Promise<T & { replayed: boolean }> {
  const key = ctx.idempotencyKey;
  if (key === undefined) {
    return { ...(await execute()), replayed: false };
  }
  if (!idempotencyKeySchema.safeParse(key).success) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "The idempotency key is not valid.", { field: "idempotencyKey" });
  }
  const route = `engine-bookings:${fn}`;
  const hash = sha256Hex(canonicalJson(canonicalInput));

  // An expired key (older than 24 h) no longer counts.
  await sql.query("delete from idempotency_keys where tenant_id = $1 and key = $2 and route = $3 and expires_at < now()", [
    ctx.tenantId,
    key,
    route,
  ]);
  const claim = await sql.query<{ id: string }>(
    `insert into idempotency_keys (tenant_id, key, route, request_hash, status)
     values ($1, $2, $3, $4, 'in_progress')
     on conflict on constraint idempotency_keys_unique_key do nothing
     returning id`,
    [ctx.tenantId, key, route, hash],
  );

  if (claim.rows.length === 0) {
    const existing = await sql.query<Stored>(
      "select request_hash, status, response_body from idempotency_keys where tenant_id = $1 and key = $2 and route = $3",
      [ctx.tenantId, key, route],
    );
    const row = existing.rows[0];
    if (!row) throw new AppError(ErrorCode.CONFLICT, "Try again.");
    if (row.request_hash !== hash) throw new AppError(ErrorCode.IDEMPOTENCY_CONFLICT);
    if (row.status !== "completed" || row.response_body === null) {
      throw new AppError(ErrorCode.CONFLICT, "This request is still being processed. Try again shortly.");
    }
    return { ...(row.response_body as unknown as T), replayed: true };
  }

  const result = await execute();
  await sql.query(
    `update idempotency_keys set status = 'completed', response_status = 200, response_body = $2::jsonb, updated_at = now()
      where id = $1`,
    [(claim.rows[0] as { id: string }).id, JSON.stringify(result)],
  );
  return { ...result, replayed: false };
}
