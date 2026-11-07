// cancel_booking: HOLD or CONFIRMED -> CANCELLED under the cancellation policy snapshotted at confirmation.
import {
  AppError,
  BookingStatus,
  CancellationLate,
  ErrorCode,
  assertTransition,
  cancelBookingSchema,
  type EngineContext,
  type SqlClient,
} from "@qenbel/shared";
import { loadBookingFor } from "./access.ts";
import { loadConfig, type EngineOptions } from "./config.ts";
import { BookingAuditAction, recordChange } from "./events.ts";
import { withIdempotency } from "./idempotency.ts";
import { isLateChange, judgeCancellation, policyFor } from "./policy.ts";
import { assertVersion, loadBooking, toView } from "./repo.ts";
import { parseOrThrow, splitBookingId } from "./schemas.ts";
import type { CancelResult, CancellationOutcome } from "./types.ts";
import { assertScope, guarded } from "./util.ts";
import { customerRulesApply } from "./window.ts";
import { toPaise } from "@qenbel/db";

const FREE: Omit<CancellationOutcome, "cancelUntilHoursBefore" | "lateCancellation" | "hoursBeforeStart"> = {
  outcome: "free",
  late: false,
  feePaise: 0,
  depositRefundPaise: 0,
};

/**
 * Cancel a booking. Input `{ bookingId, reason?, expectedVersion? }`.
 *
 * A HOLD cancels freely. For a CONFIRMED booking the rules come from the snapshot taken at confirmation
 * (today's pack and tenant rules for anything the snapshot lacks):
 *  - outside the free window: free;
 *  - inside it, policy `allow`: accepted, no fee;  `flag`: accepted, flagged, fee = late fee or the forfeited deposit;
 *  - inside it, policy `block`: customer channels (anything but the dashboard) are refused with FORBIDDEN and nothing
 *    changes; staff on the dashboard may still cancel, treated as `flag`.
 * The outcome is returned and stored under `policy.cancellation`. The slot is released by the database when the status changes.
 */
export async function cancelBooking(
  sql: SqlClient,
  ctx: EngineContext,
  rawInput: unknown,
  options: EngineOptions = {},
): Promise<CancelResult> {
  return guarded(async () => {
    await assertScope(sql, ctx);
    const { bookingId, body: rawBody } = splitBookingId(rawInput);
    const body = parseOrThrow(cancelBookingSchema, rawBody);
    const cfg = await loadConfig(sql, ctx, options);
    return withIdempotency(sql, ctx, "cancel_booking", { bookingId, ...body }, async () => {
      // Customer channels: only the subject's own booking; anything else is NOT_FOUND (SEC-008).
      const row = await loadBookingFor(sql, ctx, bookingId, { lock: true });
      assertVersion(row, body.expectedVersion);
      assertTransition(cfg.machine, row.status, BookingStatus.CANCELLED, "booking");

      const nowMs = ctx.now().getTime();
      const startMs = row.starts_at.getTime();
      const policy = policyFor(row.policy_snapshot, cfg);
      let outcome: CancellationOutcome;
      if (row.status === BookingStatus.HOLD) {
        outcome = {
          ...FREE,
          hoursBeforeStart: Math.round(((startMs - nowMs) / 3_600_000) * 100) / 100,
          cancelUntilHoursBefore: policy.cancelUntilHoursBefore,
          lateCancellation: policy.lateCancellation,
        };
      } else {
        if (
          policy.lateCancellation === CancellationLate.BLOCK &&
          isLateChange(policy, startMs, nowMs) &&
          customerRulesApply(ctx)
        ) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "This booking is too close to its start time to cancel here. Please contact the business.",
            { reason: "late_cancellation_blocked", cancelUntilHoursBefore: policy.cancelUntilHoursBefore },
          );
        }
        outcome = judgeCancellation(policy, startMs, nowMs, { paise: toPaise(row.deposit_paise), status: row.deposit_status });
      }

      await sql.query(
        `update bookings
            set status = 'CANCELLED', cancelled_at = $3, cancellation_reason = $4,
                policy_snapshot = coalesce(policy_snapshot, '{}'::jsonb) || jsonb_build_object('cancellation', $5::jsonb),
                version = version + 1, updated_at = now()
          where tenant_id = $1 and id = $2`,
        [ctx.tenantId, bookingId, ctx.now().toISOString(), body.reason ?? null, JSON.stringify(outcome)],
      );
      const view = toView(await loadBooking(sql, ctx, bookingId));
      await recordChange(sql, ctx, BookingAuditAction.CANCEL, view, row.status, {
        outcome: outcome.outcome,
        late: outcome.late,
        feePaise: outcome.feePaise,
        depositRefundPaise: outcome.depositRefundPaise,
      });
      return { booking: view, cancellation: outcome };
    });
  });
}
