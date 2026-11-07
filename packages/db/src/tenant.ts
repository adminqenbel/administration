import { createHmac } from "node:crypto";
import type { Pool, PoolClient } from "./pool.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// "user:<uuid>", "credential:<uuid>", optionally "/conv:<id>"; same alphabet as the CHECK on idempotency_keys.principal (migration 018).
const PRINCIPAL_RE = /^[A-Za-z0-9_:./-]{1,200}$/;

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export interface TenantTxOptions {
  readOnly?: boolean;
  isolationLevel?: IsolationLevel;
  /**
   * Who is acting, for example `user:<uuid>` or `credential:<uuid>` (plus `/conv:<id>` for a channel conversation).
   * Sets app.principal for this transaction; idempotency rows are then visible only to this principal (migration 018).
   * Must come from the authenticated principal, never from input.
   */
  principal?: string;
  /** Tenant-proof key for this call (overrides configureTenantProof / QENBEL_TENANT_PROOF_KEY). See migration 021. */
  proofKey?: Buffer | null;
}

let configuredProofKey: Buffer | null | undefined; // undefined = not configured yet: read the environment once

/** Parse a hex tenant-proof key (at least 32 bytes). */
export function parseTenantProofKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64,}$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("tenant proof key must be hex, at least 64 characters (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Set the process-wide tenant-proof key used by withTenant (null switches it off). When never called, the key is read
 * once from QENBEL_TENANT_PROOF_KEY (hex). The database must hold the same key (platform_set_tenant_proof_keys, migration 021).
 */
export function configureTenantProof(key: Buffer | string | null): void {
  configuredProofKey = key === null ? null : typeof key === "string" ? parseTenantProofKey(key) : key;
}

function processProofKey(): Buffer | null {
  if (configuredProofKey === undefined) {
    const hex = process.env.QENBEL_TENANT_PROOF_KEY;
    configuredProofKey = hex ? parseTenantProofKey(hex) : null;
  }
  return configuredProofKey;
}

/** hex(HMAC-SHA256(key, 'qenbel.tenant:' || tenantId)): the value current_tenant_id() expects in app.tenant_proof. */
export function tenantProof(key: Buffer, tenantId: string): string {
  return createHmac("sha256", key).update(`qenbel.tenant:${tenantId.toLowerCase()}`).digest("hex");
}

/**
 * Run `fn` in one transaction scoped to a tenant. This is the only way request handlers and jobs
 * should touch tenant tables: the transaction starts with
 *   select set_config('app.tenant_id', $1, true), set_config('app.principal', $2, true), set_config('app.tenant_proof', $3, true)
 * so Row-Level Security applies for exactly this transaction and the settings cannot leak to the next
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
  if (options.principal !== undefined && (typeof options.principal !== "string" || !PRINCIPAL_RE.test(options.principal))) {
    throw new TypeError("withTenant: principal must match [A-Za-z0-9_:./-]{1,200}");
  }
  const key = options.proofKey !== undefined ? options.proofKey : processProofKey();
  const proof = key ? tenantProof(key, tenantId) : "";
  const client = await pool.connect();
  let destroy: Error | undefined;
  try {
    const mode = [
      options.isolationLevel ? `ISOLATION LEVEL ${options.isolationLevel}` : "",
      options.readOnly ? "READ ONLY" : "",
    ].filter(Boolean).join(" ");
    await client.query(`BEGIN ${mode}`.trim());
    await client.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.principal', $2, true), set_config('app.tenant_proof', $3, true)",
      [tenantId, options.principal ?? "", proof],
    );
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

/**
 * Ids of active tenants, for workers that visit every tenant (each visit must then use withTenant).
 * `platformPool` must connect as qenbel_platform_ops (DATABASE_PLATFORM_URL); the runtime role cannot call it.
 */
export async function listActiveTenantIds(platformPool: Pool): Promise<string[]> {
  const res = await platformPool.query<{ id: string }>("select platform_list_active_tenants() as id");
  return res.rows.map((r) => r.id);
}

/**
 * Expire stale booking holds in every tenant, using the database clock. Returns how many holds expired.
 * For the background job. `platformPool` must connect as qenbel_platform_ops. (The caller-chosen `now` was removed in
 * migration 017: a future time expired every live hold of every tenant.)
 */
export async function expireBookingHolds(platformPool: Pool): Promise<number> {
  const res = await platformPool.query<{ n: number }>("select expire_booking_holds() as n");
  return Number(res.rows[0]?.n ?? 0);
}

/** Delete expired idempotency rows in every tenant. `platformPool` must connect as qenbel_platform_ops. */
export async function purgeExpiredIdempotencyKeys(platformPool: Pool): Promise<number> {
  const res = await platformPool.query<{ n: number }>("select purge_expired_idempotency_keys() as n");
  return Number(res.rows[0]?.n ?? 0);
}
