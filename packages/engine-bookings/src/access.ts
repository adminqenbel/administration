// Who may touch which booking (SEC-008), and the per-channel hold limits (SEC-004).
//
// Customer channels are web_chat, whatsapp and voice. On them the caller is an end customer driving the AI or the widget,
// identified only by ctx.subject, which the channel layer sets from the verified contact (never from tool arguments):
//   subject.customerId      the verified customer (WhatsApp sender, matched caller id, signed-in widget user)
//   subject.conversationId  the conversation the call belongs to (anonymous widget sessions have only this)
// Every customer-scoped operation on these channels fails closed: no subject, or a booking that is not the subject's,
// answers exactly like an id that does not exist (NOT_FOUND, same message and details).
// `dashboard` (staff) and `api` (a trusted server integration with its own credential) are not restricted by ownership.
import {
  AppError,
  Channel,
  ErrorCode,
  type EngineContext,
  type SqlClient,
} from "@qenbel/shared";
import type { BookingConfig } from "./config.ts";
import { loadBooking, notFound, type BookingRow } from "./repo.ts";
import { sha256Hex } from "./util.ts";

export const CUSTOMER_CHANNELS: readonly Channel[] = [Channel.WEB_CHAT, Channel.WHATSAPP, Channel.VOICE];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCustomerChannel(ctx: EngineContext): boolean {
  // Fail closed: anything that is not an explicitly trusted channel is treated as a customer channel.
  return !(ctx.actor.channel === Channel.DASHBOARD || ctx.actor.channel === Channel.API);
}

export interface Subject {
  customerId: string | null;
  conversationId: string | null;
}

/** The subject as lower-case uuids. Anything that is not a uuid counts as absent (fail closed). */
export function subjectOf(ctx: EngineContext): Subject {
  const norm = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null);
  return { customerId: norm(ctx.subject?.customerId), conversationId: norm(ctx.subject?.conversationId) };
}

const low = (v: string | null): string | null => (v === null ? null : v.toLowerCase());

/**
 * Does the subject own this booking?
 *  - the verified customer is the booking's customer; or
 *  - the booking was made in this conversation, and is not another verified customer's booking.
 */
export function ownsBooking(subject: Subject, row: { customer_id: string | null; conversation_id: string | null }): boolean {
  const cust = low(row.customer_id);
  const conv = low(row.conversation_id);
  if (subject.customerId !== null && cust === subject.customerId) return true;
  if (subject.conversationId !== null && conv === subject.conversationId) {
    return !(subject.customerId !== null && cust !== null && cust !== subject.customerId);
  }
  return false;
}

/**
 * Load a booking the caller may act on. Off customer channels this is `loadBooking`. On them, ownership is checked on an
 * unlocked read first (so a foreign id never takes or waits for a row lock), then again on the locked row.
 */
export async function loadBookingFor(
  sql: SqlClient,
  ctx: EngineContext,
  bookingId: string,
  options: { lock?: boolean } = {},
): Promise<BookingRow> {
  if (!isCustomerChannel(ctx)) return loadBooking(sql, ctx, bookingId, options);
  await assertOwnsBooking(sql, ctx, bookingId);
  const row = await loadBooking(sql, ctx, bookingId, options);
  if (!ownsBooking(subjectOf(ctx), row)) throw notFound();
  return row;
}

/** Customer channels: NOT_FOUND unless the subject owns the booking. No row lock is taken. */
export async function assertOwnsBooking(sql: SqlClient, ctx: EngineContext, bookingId: string): Promise<void> {
  if (!isCustomerChannel(ctx)) return;
  const subject = subjectOf(ctx);
  if (subject.customerId === null && subject.conversationId === null) throw notFound();
  const res = await sql.query<{ customer_id: string | null; conversation_id: string | null }>(
    "select customer_id, conversation_id from bookings where tenant_id = $1 and id = $2",
    [ctx.tenantId, bookingId],
  );
  const row = res.rows[0];
  if (!row || !ownsBooking(subject, row)) throw notFound();
}

/** Staff-only operations (check-in, complete, no-show, sweeps, audit history) are refused on customer channels. */
export function assertStaffChannel(ctx: EngineContext): void {
  if (isCustomerChannel(ctx)) throw new AppError(ErrorCode.FORBIDDEN, undefined, { reason: "customer_channel" });
}

/**
 * Short tag for the acting principal, folded into the engine's idempotency route so one principal can never replay or
 * probe another's key (SEC-010; the database also binds rows to app.principal since migration 018).
 */
export function principalTag(ctx: EngineContext): string {
  const s = subjectOf(ctx);
  return sha256Hex(`${ctx.actor.kind}|${ctx.actor.id}|${ctx.actor.channel}|${s.conversationId ?? ""}|${s.customerId ?? ""}`).slice(0, 16);
}

// ---- hold and booking limits (SEC-004) --------------------------------------------------------------------------

export interface BookingLimits {
  holdsPerConversation: number;
  holdsPerCustomer: number;
  holdsPerCredential: number;
  holdsPerTenant: number;
  activeBookingsPerCustomer: number;
  activeBookingsPerConversation: number;
  unverifiedHoldMinutes: number;
  resourcesPerHold: number;
}

export const DEFAULT_LIMITS: BookingLimits = {
  holdsPerConversation: 2,
  holdsPerCustomer: 5,
  holdsPerCredential: 20,
  holdsPerTenant: 100,
  activeBookingsPerCustomer: 10,
  activeBookingsPerConversation: 4,
  unverifiedHoldMinutes: 10,
  resourcesPerHold: 3,
};

/** Serialise every hold and confirm that counts against the same limit. Keys are taken in sorted order. */
export async function lockLimitKeys(sql: SqlClient, ctx: EngineContext, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`engine-bookings:limit:${ctx.tenantId}:${key}`]);
  }
}

function limitError(reason: "hold_limit" | "booking_limit", scope: string): AppError {
  const message =
    scope === "tenant"
      ? "Too many slots are being held right now. Please try again shortly."
      : reason === "hold_limit"
        ? "You already have the most held slots allowed. Confirm or release one first."
        : "You already have the most upcoming bookings allowed.";
  return new AppError(ErrorCode.RATE_LIMITED, message, { reason, scope });
}

const LIVE_HOLD = "b.status = 'HOLD' and b.hold_expires_at > $2::timestamptz";
const ACTIVE = `((b.status in ('CONFIRMED', 'CHECKED_IN') and b.ends_at > $2::timestamptz) or (${LIVE_HOLD}))`;

async function count(sql: SqlClient, ctx: EngineContext, where: string, params: readonly unknown[]): Promise<number> {
  const res = await sql.query<{ n: string }>(`select count(*) as n from bookings b where b.tenant_id = $1 and ${where}`, [
    ctx.tenantId,
    ctx.now().toISOString(),
    ...params,
  ]);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * createHold on a customer channel: lock the limit keys, then count live holds and active bookings. Runs before any
 * resource lock (lock order: limit keys -> resources -> bookings -> allocations), so a burst from one conversation is
 * serialised and at most the limit gets through.
 */
export async function enforceHoldLimits(sql: SqlClient, ctx: EngineContext, cfg: BookingConfig, subject: Subject): Promise<void> {
  const l = cfg.limits;
  const actor = `${ctx.actor.kind}:${ctx.actor.id}`;
  const keys = ["tenant", `actor:${actor}`];
  if (subject.conversationId !== null) keys.push(`conv:${subject.conversationId}`);
  if (subject.customerId !== null) keys.push(`cust:${subject.customerId}`);
  await lockLimitKeys(sql, ctx, keys);

  const channels = [...CUSTOMER_CHANNELS];
  if (subject.conversationId !== null) {
    if ((await count(sql, ctx, `${LIVE_HOLD} and b.conversation_id = $3`, [subject.conversationId])) >= l.holdsPerConversation) {
      throw limitError("hold_limit", "conversation");
    }
    if ((await count(sql, ctx, `${ACTIVE} and b.conversation_id = $3`, [subject.conversationId])) >= l.activeBookingsPerConversation) {
      throw limitError("booking_limit", "conversation");
    }
  }
  if (subject.customerId !== null) {
    if ((await count(sql, ctx, `${LIVE_HOLD} and b.customer_id = $3`, [subject.customerId])) >= l.holdsPerCustomer) {
      throw limitError("hold_limit", "customer");
    }
    if ((await count(sql, ctx, `${ACTIVE} and b.customer_id = $3`, [subject.customerId])) >= l.activeBookingsPerCustomer) {
      throw limitError("booking_limit", "customer");
    }
  }
  const byActor = await count(
    sql,
    ctx,
    `${LIVE_HOLD} and b.source_channel = any($3::text[]) and exists (
       select 1 from audit_log l where l.tenant_id = b.tenant_id and l.entity_type = 'booking' and l.entity_id = b.id::text
          and l.action = 'booking.hold' and l.actor_kind = $4 and l.actor_id = $5)`,
    [channels, ctx.actor.kind, ctx.actor.id],
  );
  if (byActor >= l.holdsPerCredential) throw limitError("hold_limit", "credential");
  if ((await count(sql, ctx, `${LIVE_HOLD} and b.source_channel = any($3::text[])`, [channels])) >= l.holdsPerTenant) {
    throw limitError("hold_limit", "tenant");
  }
}

/** Advisory keys a customer-channel confirm takes before it locks the booking (same keys as createHold). */
export function confirmLimitKeys(subject: Subject): string[] {
  const keys: string[] = [];
  if (subject.conversationId !== null) keys.push(`conv:${subject.conversationId}`);
  if (subject.customerId !== null) keys.push(`cust:${subject.customerId}`);
  return keys;
}

/** confirm on a customer channel: the customer the booking will belong to must stay under the active-bookings limit. */
export async function enforceActiveLimit(sql: SqlClient, ctx: EngineContext, cfg: BookingConfig, customerId: string, bookingId: string): Promise<void> {
  const n = await count(sql, ctx, `${ACTIVE} and b.customer_id = $3 and b.id <> $4`, [customerId, bookingId]);
  if (n >= cfg.limits.activeBookingsPerCustomer) throw limitError("booking_limit", "customer");
}
