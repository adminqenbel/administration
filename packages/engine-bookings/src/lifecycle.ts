// Check-in, completion and no-show: the plain forward moves of a confirmed booking.
import {
  AppError,
  BookingStatus,
  ErrorCode,
  assertTransition,
  transitionBookingSchema,
  type EngineContext,
  type SqlClient,
} from "@qenbel/shared";
import { assertStaffChannel } from "./access.ts";
import { loadConfig, type EngineOptions } from "./config.ts";
import { BookingAuditAction, recordChange } from "./events.ts";
import { withIdempotency } from "./idempotency.ts";
import { assertVersion, loadBooking, toView } from "./repo.ts";
import { lifecycleInputSchema, parseOrThrow, splitBookingId } from "./schemas.ts";
import type { WriteResult } from "./types.ts";
import { assertScope, guarded } from "./util.ts";

type Target = typeof BookingStatus.CHECKED_IN | typeof BookingStatus.COMPLETED | typeof BookingStatus.NO_SHOW;

const ACTION_FOR: Record<Target, BookingAuditAction> = {
  [BookingStatus.CHECKED_IN]: BookingAuditAction.CHECK_IN,
  [BookingStatus.COMPLETED]: BookingAuditAction.COMPLETE,
  [BookingStatus.NO_SHOW]: BookingAuditAction.NO_SHOW,
};

const FN_FOR: Record<Target, string> = {
  [BookingStatus.CHECKED_IN]: "check_in",
  [BookingStatus.COMPLETED]: "complete",
  [BookingStatus.NO_SHOW]: "mark_no_show",
};

async function moveTo(
  sql: SqlClient,
  ctx: EngineContext,
  rawInput: unknown,
  to: Target,
  options: EngineOptions,
): Promise<WriteResult> {
  return guarded(async () => {
    await assertScope(sql, ctx);
    assertStaffChannel(ctx);
    const { bookingId, body: rawBody } = splitBookingId(rawInput);
    const body = parseOrThrow(lifecycleInputSchema, rawBody);
    const cfg = await loadConfig(sql, ctx, options);
    return withIdempotency(sql, ctx, FN_FOR[to], { bookingId, ...body }, async () => {
      const row = await loadBooking(sql, ctx, bookingId, { lock: true });
      assertVersion(row, body.expectedVersion);
      assertTransition(cfg.machine, row.status, to, "booking");

      // A no-show is only meaningful once the booking time has begun.
      if (to === BookingStatus.NO_SHOW && ctx.now().getTime() < row.starts_at.getTime()) {
        throw new AppError(ErrorCode.CONFLICT, "A booking cannot be marked as a no-show before it starts.", {
          reason: "not_started",
        });
      }

      await sql.query(
        "update bookings set status = $3, version = version + 1, updated_at = now() where tenant_id = $1 and id = $2",
        [ctx.tenantId, bookingId, to],
      );
      const view = toView(await loadBooking(sql, ctx, bookingId));
      await recordChange(sql, ctx, ACTION_FOR[to], view, row.status);
      return { booking: view };
    });
  });
}

/** CONFIRMED -> CHECKED_IN. Input `{ bookingId, expectedVersion }`. */
export function checkIn(sql: SqlClient, ctx: EngineContext, rawInput: unknown, options: EngineOptions = {}): Promise<WriteResult> {
  return moveTo(sql, ctx, rawInput, BookingStatus.CHECKED_IN, options);
}

/** CHECKED_IN -> COMPLETED. Input `{ bookingId, expectedVersion }`. */
export function complete(sql: SqlClient, ctx: EngineContext, rawInput: unknown, options: EngineOptions = {}): Promise<WriteResult> {
  return moveTo(sql, ctx, rawInput, BookingStatus.COMPLETED, options);
}

/** CONFIRMED -> NO_SHOW, from the start time on. Releases the slot. Input `{ bookingId, expectedVersion }`. */
export function markNoShow(sql: SqlClient, ctx: EngineContext, rawInput: unknown, options: EngineOptions = {}): Promise<WriteResult> {
  return moveTo(sql, ctx, rawInput, BookingStatus.NO_SHOW, options);
}

/**
 * The dashboard's `POST /bookings/{id}/transition`: `{ bookingId, to: CHECKED_IN | COMPLETED | NO_SHOW, expectedVersion }`.
 * Any other `to` (CANCELLED, EXPIRED, CONFIRMED ...) is VALIDATION_FAILED: those have their own actions.
 */
export async function transitionBooking(sql: SqlClient, ctx: EngineContext, rawInput: unknown, options: EngineOptions = {}): Promise<WriteResult> {
  const { bookingId, body } = splitBookingId(rawInput);
  const parsed = parseOrThrow(transitionBookingSchema, body);
  return moveTo(sql, ctx, { bookingId, expectedVersion: parsed.expectedVersion }, parsed.to, options);
}
