// Shared plumbing for the order engine: tenant-session check, input parsing, audit, outbox, idempotency.
import { createHash } from "node:crypto";
import {
  AppError,
  ErrorCode,
  idempotencyKeySchema,
  isAppError,
  parseOrThrow,
  type DomainEventInput,
  type EngineContext,
  type SqlClient,
  type WebhookEvent as WebhookEventType,
} from "@qenbel/shared";
import type { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An order-engine error whose `details.reason` is a stable machine-readable name (the registry's error names). */
export function orderError(code: ErrorCode, reason: string, message?: string, details: Record<string, unknown> = {}): AppError {
  return new AppError(code, message, { reason, ...details });
}

export const notFound = (reason: string, details: Record<string, unknown> = {}): AppError =>
  orderError(ErrorCode.NOT_FOUND, reason, "Not found.", details);

export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  return parseOrThrow(schema, input);
}

/**
 * Every engine function starts here. The tenant comes from ctx only; this also proves the SQL client really is
 * inside `withTenant` for the SAME tenant. A mismatch (or a client outside withTenant) stops before any write.
 */
export async function assertTenantSession(sql: SqlClient, ctx: EngineContext): Promise<void> {
  if (!ctx || typeof ctx.tenantId !== "string" || !UUID_RE.test(ctx.tenantId)) {
    throw new AppError(ErrorCode.TENANT_REQUIRED);
  }
  const res = await sql.query<{ ok: boolean | null }>("select (current_tenant_id() = $1::uuid) as ok", [ctx.tenantId]);
  if (res.rows[0]?.ok !== true) {
    throw new AppError(ErrorCode.TENANT_REQUIRED, "The database session is not scoped to this business.");
  }
}

/** Run money maths; a RangeError (overflow, bad rate, discount above subtotal) becomes VALIDATION_FAILED. */
export function money<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RangeError) {
      throw orderError(ErrorCode.VALIDATION_FAILED, "AMOUNT_INVALID", err.message);
    }
    throw err;
  }
}

/** Convert the few Postgres errors an engine can legitimately hit into AppErrors; everything else propagates. */
export function mapPgError(err: unknown): never {
  if (isAppError(err)) throw err;
  const e = err as { code?: string };
  if (e && typeof e === "object") {
    // Constraint names stay out of the details: they describe the schema to the caller.
    if (e.code === "23505") throw orderError(ErrorCode.CONFLICT, "DUPLICATE", "This record already exists.");
    if (e.code === "23514") throw orderError(ErrorCode.VALIDATION_FAILED, "CHECK_VIOLATION");
    if (e.code === "23503") throw orderError(ErrorCode.NOT_FOUND, "REFERENCE_NOT_FOUND");
  }
  throw err;
}

// ---- audit and outbox ------------------------------------------------------------------------------------

export async function audit(
  sql: SqlClient,
  ctx: EngineContext,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await sql.query(
    `insert into audit_log (tenant_id, actor_kind, actor_id, action, entity_type, entity_id, channel, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [ctx.tenantId, ctx.actor.kind, ctx.actor.id, action, entityType, entityId, ctx.actor.channel, JSON.stringify(details)],
  );
}

/** Queue a webhook event in the same transaction as the change. `eventId` is the subscriber's de-duplication key. */
export async function emitEvent(
  sql: SqlClient,
  ctx: EngineContext,
  type: Extract<
    WebhookEventType,
    | "order.created"
    | "order.accepted"
    | "order.fulfilled"
    | "order.cancelled"
    | "order.rejected"
    | "payment.completed"
    | "payment.refunded"
    | "customer.created"
  >,
  event: Omit<DomainEventInput, "type">,
): Promise<string> {
  const eventId = ctx.newId();
  await sql.query(
    `insert into outbox_events (tenant_id, event_id, type, aggregate_type, aggregate_id, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [ctx.tenantId, eventId, type, event.aggregateType, event.aggregateId, JSON.stringify(event.payload)],
  );
  return eventId;
}

// ---- idempotency -----------------------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** sha256 over key-sorted JSON, so field order never changes the hash. */
export function hashInput(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

/**
 * A short digest of WHO is calling (actor kind and id, channel, verified customer and conversation). It is folded into
 * the idempotency route, so another credential or customer that repeats the same key gets a plain miss: it can neither
 * replay the first caller's result nor learn (through IDEMPOTENCY_CONFLICT) that the key exists.
 */
export function principalTag(ctx: EngineContext): string {
  const parts = [ctx.actor.kind, ctx.actor.id, ctx.actor.channel, ctx.subject?.customerId ?? "", ctx.subject?.conversationId ?? ""];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

export function requireIdempotencyKey(ctx: EngineContext): string | undefined {
  if (ctx.idempotencyKey === undefined) return undefined;
  return parseOrThrow(idempotencyKeySchema, ctx.idempotencyKey);
}

/**
 * Run `run` at most once per (tenant, ctx.idempotencyKey, route). The key row is claimed with
 * INSERT ... ON CONFLICT DO NOTHING; a concurrent duplicate blocks on the unique index until the first
 * transaction ends, then replays its result (or, if that one rolled back, runs itself).
 * Same key with a different input is IDEMPOTENCY_CONFLICT. Without a key, `run` simply runs.
 * `run` returns the id of the entity it made; `load` turns that id back into the response.
 */
export async function withIdempotency<T>(
  sql: SqlClient,
  ctx: EngineContext,
  routeName: string,
  input: unknown,
  run: () => Promise<string>,
  load: (entityId: string) => Promise<T>,
): Promise<T> {
  const key = requireIdempotencyKey(ctx);
  if (key === undefined) return load(await run());
  const requestHash = hashInput(input);
  const route = `${routeName}:${principalTag(ctx)}`;

  // An expired key (older than 24 h, not yet purged) no longer counts.
  await sql.query("delete from idempotency_keys where tenant_id = $1 and key = $2 and route = $3 and expires_at < now()", [
    ctx.tenantId,
    key,
    route,
  ]);
  const claimed = await sql.query<{ id: string }>(
    `insert into idempotency_keys (tenant_id, key, route, request_hash, status)
     values ($1, $2, $3, $4, 'in_progress')
     on conflict on constraint idempotency_keys_unique_key do nothing
     returning id`,
    [ctx.tenantId, key, route, requestHash],
  );
  const claimId = claimed.rows[0]?.id;
  if (claimId !== undefined) {
    const entityId = await run();
    await sql.query(
      `update idempotency_keys set status = 'completed', response_status = 200, response_body = $2::jsonb
       where tenant_id = $3 and id = $1`,
      [claimId, JSON.stringify({ id: entityId }), ctx.tenantId],
    );
    return load(entityId);
  }

  const existing = await sql.query<{ request_hash: string; status: string; response_body: { id?: string } | null }>(
    "select request_hash, status, response_body from idempotency_keys where tenant_id = $1 and key = $2 and route = $3",
    [ctx.tenantId, key, route],
  );
  const row = existing.rows[0];
  if (!row) throw new AppError(ErrorCode.CONFLICT, "Try again.", { reason: "IDEMPOTENCY_RACE" });
  if (row.request_hash !== requestHash) throw new AppError(ErrorCode.IDEMPOTENCY_CONFLICT);
  const entityId = row.response_body?.id;
  if (row.status !== "completed" || typeof entityId !== "string") {
    throw new AppError(ErrorCode.CONFLICT, "This request is still being processed.", { reason: "IDEMPOTENCY_IN_PROGRESS" });
  }
  return load(entityId);
}
