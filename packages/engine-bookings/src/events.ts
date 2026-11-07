// Audit trail and transactional outbox. Both are written on the caller's transaction, so they commit
// or roll back together with the booking change.
import { WebhookEvent, type EngineContext, type SqlClient } from "@qenbel/shared";
import type { BookingView } from "./types.ts";

export const BookingAuditAction = {
  HOLD: "booking.hold",
  CONFIRM: "booking.confirm",
  RESCHEDULE: "booking.reschedule",
  CANCEL: "booking.cancel",
  CHECK_IN: "booking.check_in",
  COMPLETE: "booking.complete",
  NO_SHOW: "booking.no_show",
  EXPIRE: "booking.expire",
} as const;
export type BookingAuditAction = (typeof BookingAuditAction)[keyof typeof BookingAuditAction];

export const OUTBOX_BY_ACTION: Partial<Record<BookingAuditAction, WebhookEvent>> = {
  [BookingAuditAction.HOLD]: WebhookEvent.BOOKING_CREATED,
  [BookingAuditAction.CONFIRM]: WebhookEvent.BOOKING_CONFIRMED,
  [BookingAuditAction.RESCHEDULE]: WebhookEvent.BOOKING_RESCHEDULED,
  [BookingAuditAction.CANCEL]: WebhookEvent.BOOKING_CANCELLED,
  [BookingAuditAction.NO_SHOW]: WebhookEvent.BOOKING_NO_SHOW,
  [BookingAuditAction.COMPLETE]: WebhookEvent.BOOKING_COMPLETED,
  [BookingAuditAction.EXPIRE]: WebhookEvent.BOOKING_EXPIRED,
};

/** Who did it, from which channel, and what changed. Never put secrets or free text from customers in `details`. */
export async function recordAudit(
  sql: SqlClient,
  ctx: EngineContext,
  action: BookingAuditAction,
  bookingId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await sql.query(
    `insert into audit_log (tenant_id, actor_kind, actor_id, action, entity_type, entity_id, outcome, channel, details)
     values ($1, $2, $3, $4, 'booking', $5, 'success', $6, $7::jsonb)`,
    [ctx.tenantId, ctx.actor.kind, ctx.actor.id, action, bookingId, ctx.actor.channel, JSON.stringify(details)],
  );
}

/** Outbox payload: the booking as the dashboard would show it, without free-text notes or the policy blob. */
export function eventPayload(
  ctx: EngineContext,
  booking: BookingView,
  previousStatus: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    bookingId: booking.id,
    reference: booking.reference,
    status: booking.status,
    previousStatus,
    version: booking.version,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    resourceIds: booking.resourceIds,
    customerId: booking.customerId,
    catalogueItemId: booking.catalogueItemId,
    partySize: booking.partySize,
    source: booking.source,
    depositPaise: booking.depositPaise,
    actor: { kind: ctx.actor.kind, id: ctx.actor.id, channel: ctx.actor.channel },
    ...extra,
  };
}

export async function emitOutbox(
  sql: SqlClient,
  ctx: EngineContext,
  type: WebhookEvent,
  aggregateType: "booking" | "customer",
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sql.query(
    `insert into outbox_events (tenant_id, event_id, type, aggregate_type, aggregate_id, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [ctx.tenantId, ctx.newId(), type, aggregateType, aggregateId, JSON.stringify(payload)],
  );
}

/** Audit row plus (where the action has a webhook event) an outbox row. */
export async function recordChange(
  sql: SqlClient,
  ctx: EngineContext,
  action: BookingAuditAction,
  booking: BookingView,
  previousStatus: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await recordAudit(sql, ctx, action, booking.id, {
    fromStatus: previousStatus,
    toStatus: booking.status,
    version: booking.version,
    ...details,
  });
  const type = OUTBOX_BY_ACTION[action];
  if (type !== undefined) {
    await emitOutbox(sql, ctx, type, "booking", booking.id, eventPayload(ctx, booking, previousStatus, details));
  }
}
