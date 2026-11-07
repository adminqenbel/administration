// reschedule_booking: move a CONFIRMED booking in one transaction (old allocation released, new one inserted).
import {
  AllocationMode,
  AppError,
  BookingStatus,
  CancellationLate,
  ErrorCode,
  assertTransition,
  rescheduleBookingSchema,
  type EngineContext,
  type SqlClient,
} from "@qenbel/shared";
import { assertOwnsBooking, isCustomerChannel, loadBookingFor } from "./access.ts";
import type { ResourceCandidate } from "./availability-source.ts";
import { loadConfig, type EngineOptions } from "./config.ts";
import { BookingAuditAction, recordChange } from "./events.ts";
import { expireDueHolds } from "./expiry.ts";
import { withIdempotency } from "./idempotency.ts";
import { isLateChange, policyFor } from "./policy.ts";
import { assertVersion, insertAllocations, loadActiveAllocations, loadBooking, lockResources, toView } from "./repo.ts";
import { parseOrThrow, splitBookingId } from "./schemas.ts";
import { bufferFor, loadService } from "./service.ts";
import { sqlAvailabilityDataSource } from "./sql-source.ts";
import type { WriteResult } from "./types.ts";
import { assertScope, guarded, withSavepoint } from "./util.ts";
import { assertWindowOpen, customerRulesApply } from "./window.ts";

/**
 * Move a confirmed booking to a new time (and, for a single-resource booking, optionally a new resource).
 * Input `{ bookingId, startsAt, endsAt | durationMinutes?, resourceId?, expectedVersion }`; with neither end nor
 * duration the booking keeps its length.
 *
 * Atomic: the old allocations are released and the new ones inserted inside one savepoint. If the new slot is
 * taken or closed, the savepoint is rolled back, so the original booking is untouched even if the caller then
 * commits. Inside the free window, `block` refuses customer channels (FORBIDDEN); other late changes are recorded.
 */
export async function rescheduleBooking(
  sql: SqlClient,
  ctx: EngineContext,
  rawInput: unknown,
  options: EngineOptions = {},
): Promise<WriteResult> {
  return guarded(async () => {
    await assertScope(sql, ctx);
    const { bookingId, body: rawBody } = splitBookingId(rawInput);
    const body = parseOrThrow(rescheduleBookingSchema, rawBody);
    const cfg = await loadConfig(sql, ctx, options);
    const source = options.availability ?? sqlAvailabilityDataSource;
    return withIdempotency(sql, ctx, "reschedule_booking", { bookingId, ...body }, async () => {
      // Lock order: resources (ascending id) -> booking -> allocations. The resources are only known from the booking's
      // allocations, so read them without a lock, lock the resources, then lock the booking and check nothing moved.
      // Customer channels: ownership is checked before any lock is taken (SEC-008), and the length cannot change (SEC-005).
      await assertOwnsBooking(sql, ctx, bookingId);
      if (isCustomerChannel(ctx) && (body.endsAt !== undefined || body.durationMinutes !== undefined)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, "The length of a booking comes from the service.", { reason: "duration_not_allowed" });
      }
      const peek = await loadActiveAllocations(sql, ctx, bookingId);
      const peekIds = peek.map((a) => a.resource_id);
      await lockResources(sql, ctx, body.resourceId !== undefined ? [...peekIds, body.resourceId] : peekIds);

      const row = await loadBookingFor(sql, ctx, bookingId, { lock: true });
      assertVersion(row, body.expectedVersion);
      if (row.status !== BookingStatus.CONFIRMED) {
        // Only a confirmed booking has the CONFIRMED -> CONFIRMED edge; a HOLD must be confirmed first.
        throw new AppError(ErrorCode.INVALID_TRANSITION, "Only a confirmed booking can be moved.", {
          entity: "booking",
          from: row.status,
          to: BookingStatus.CONFIRMED,
        });
      }
      assertTransition(cfg.machine, BookingStatus.CONFIRMED, BookingStatus.CONFIRMED, "booking");

      const nowMs = ctx.now().getTime();
      const policy = policyFor(row.policy_snapshot, cfg);
      const late = isLateChange(policy, row.starts_at.getTime(), nowMs);
      if (late && policy.lateCancellation === CancellationLate.BLOCK && customerRulesApply(ctx)) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "This booking is too close to its start time to change here. Please contact the business.",
          { reason: "late_change_blocked", cancelUntilHoursBefore: policy.cancelUntilHoursBefore },
        );
      }

      const startMs = Date.parse(body.startsAt);
      let endMs: number;
      if (body.endsAt !== undefined) endMs = Date.parse(body.endsAt);
      else if (body.durationMinutes !== undefined) endMs = startMs + body.durationMinutes * 60_000;
      else endMs = startMs + (row.ends_at.getTime() - row.starts_at.getTime());

      const current = await loadActiveAllocations(sql, ctx, bookingId);
      if (current.length !== peek.length || current.some((a, i) => a.resource_id !== peek[i]?.resource_id)) {
        // Another change moved the booking between our read and our lock. Nothing was written; retry.
        throw new AppError(ErrorCode.VERSION_CONFLICT, undefined, { reason: "allocation_changed" });
      }
      if (current.length === 0) throw new AppError(ErrorCode.CONFLICT, "This booking has no slot to move.");
      let targets: { resourceId: string; units: number }[] = current.map((a) => ({ resourceId: a.resource_id, units: a.units }));
      if (body.resourceId !== undefined) {
        if (current.length !== 1) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, "A booking with several resources keeps its resources.", { reason: "multi_resource" });
        }
        targets = [{ resourceId: body.resourceId, units: (current[0] as { units: number }).units }];
      }

      const service = row.catalogue_item_id ? await loadService(sql, ctx, row.catalogue_item_id, { requireAvailable: false }) : null;
      const candidates = await source.listResources(sql, ctx, {
        resourceIds: targets.map((t) => t.resourceId),
        catalogueItemId: service?.id ?? null,
        requiredType: service?.requiredResourceType ?? null,
        allowedTypes: cfg.pack.resourceTypes,
        partySize: row.party_size,
        fallbackTimezone: cfg.tenantTimezone,
      });
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const set: ResourceCandidate[] = [];
      for (const t of targets) {
        const c = byId.get(t.resourceId);
        if (!c) throw new AppError(ErrorCode.NOT_FOUND, "Resource not found.", { entity: "resource" });
        if (!c.eligible) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, "That resource cannot be booked for this.", { reason: "resource_not_eligible" });
        }
        set.push(c);
      }
      const bufferMinutes = bufferFor(service, cfg);

      // Old and new resources are already locked (see above). Expire due holds on them in id order before the move.
      await expireDueHolds(sql, ctx, { cutoff: null, resourceIds: targets.map((t) => t.resourceId), reason: "slot_requested" });

      await withSavepoint(sql, async () => {
        await sql.query(
          "update booking_allocations set active = false, updated_at = now() where tenant_id = $1 and booking_id = $2 and active",
          [ctx.tenantId, bookingId],
        );
        await assertWindowOpen(sql, ctx, cfg, source, set, startMs, endMs);
        await insertAllocations(
          sql,
          ctx,
          bookingId,
          set.map((r) => {
            const exclusive = r.allocationMode === AllocationMode.EXCLUSIVE;
            return {
              resourceId: r.id,
              units: (targets.find((t) => t.resourceId === r.id) as { units: number }).units,
              startMs,
              endMs: exclusive ? endMs + bufferMinutes * 60_000 : endMs,
            };
          }),
          null,
        );
        await sql.query(
          `update bookings
              set starts_at = $3, ends_at = $4, version = version + 1, updated_at = now(),
                  policy_snapshot = coalesce(policy_snapshot, '{}'::jsonb)
                    || jsonb_build_object('lastRescheduledAt', $5::text, 'lastRescheduleLate', $6::boolean)
            where tenant_id = $1 and id = $2`,
          [ctx.tenantId, bookingId, new Date(startMs).toISOString(), new Date(endMs).toISOString(), ctx.now().toISOString(), late],
        );
      });

      const view = toView(await loadBooking(sql, ctx, bookingId));
      await recordChange(sql, ctx, BookingAuditAction.RESCHEDULE, view, row.status, {
        late,
        from: {
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at.toISOString(),
          resourceIds: current.map((a) => a.resource_id),
        },
        to: { startsAt: view.startsAt, endsAt: view.endsAt, resourceIds: view.resourceIds },
      });
      return { booking: view };
    });
  });
}
