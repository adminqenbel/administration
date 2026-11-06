import type { Pool, PoolClient } from "./pool.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export interface TenantTxOptions {
  readOnly?: boolean;
  isolationLevel?: IsolationLevel;
}

/**
 * Run `fn` in one transaction scoped to a tenant. This is the only way request handlers and jobs
 * should touch tenant tables: the transaction starts with
 *   select set_config('app.tenant_id', $1, true)
 * so Row-Level Security applies for exactly this transaction and the setting cannot leak to the next
 * user of a pooled connection. `tenantId` must come from the authenticated principal, never from input.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
  options: TenantTxOptions = {},
): Promise<T> {
  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
    throw new TypeError("withTenant: tenantId must be a UUID");
  }
  const client = await pool.connect();
  let destroy: Error | undefined;
  try {
    const mode = [
      options.isolationLevel ? `ISOLATION LEVEL ${options.isolationLevel}` : "",
      options.readOnly ? "READ ONLY" : "",
    ].filter(Boolean).join(" ");
    await client.query(`BEGIN ${mode}`.trim());
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // The connection is unusable: destroy it instead of returning it to the pool.
      destroy = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(destroy);
  }
}

/** Ids of active tenants, for workers that visit every tenant (each visit must then use withTenant). */
export async function listActiveTenantIds(pool: Pool): Promise<string[]> {
  const res = await pool.query<{ id: string }>("select platform_list_active_tenants() as id");
  return res.rows.map((r) => r.id);
}

/** Expire stale booking holds in every tenant. Returns how many holds expired. For the background job. */
export async function expireBookingHolds(pool: Pool, now?: Date): Promise<number> {
  const res = await pool.query<{ n: number }>("select expire_booking_holds(coalesce($1::timestamptz, clock_timestamp())) as n", [
    now ?? null,
  ]);
  return Number(res.rows[0]?.n ?? 0);
}
