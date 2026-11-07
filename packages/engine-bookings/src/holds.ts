// create_booking_hold: a short-lived HOLD that occupies the slot until confirmed or expired.
import {
  AppError,
  ErrorCode,
  AllocationMode,
  type EngineContext,
  type SqlClient,
} from "@qenbel/shared";
import type { ResourceCandidate } from "./availability-source.ts";
import { loadConfig, type BookingConfig, type EngineOptions } from "./config.ts";
import { BookingAuditAction, recordChange } from "./events.ts";
import { withIdempotency } from "./idempotency.ts";
import { insertAllocations, loadBooking, lockResources, toView } from "./repo.ts";
import { createHoldInputSchema, parseOrThrow } from "./schemas.ts";
import { bufferFor, loadService } from "./service.ts";
import { sqlAvailabilityDataSource } from "./sql-source.ts";
import type { WriteResult } from "./types.ts";
import { assertScope, guarded, translateDbError, withSavepoint } from "./util.ts";
import { assertWindowOpen, slotUnavailable, type WindowReason } from "./window.ts";

async function assertCustomerUsable(sql: SqlClient, ctx: EngineContext, customerId: string): Promise<void> {
  const res = await sql.query("select 1 from customers where tenant_id = $1 and id = $2 and archived_at is null", [ctx.tenantId, customerId]);
  if (res.rows.length === 0) throw new AppError(ErrorCode.NOT_FOUND, "Customer not found.", { entity: "customer" });
}

/** A party across several exclusive tables must fit in them together; one table must fit the party. */
function assertPartyFits(set: readonly ResourceCandidate[], partySize: number | undefined): void {
  if (partySize === undefined) return;
  const tables = set.filter((r) => r.type === "table" && r.allocationMode === AllocationMode.EXCLUSIVE);
  if (tables.length === 0 || tables.length !== set.length) return;
  const seats = tables.reduce((sum, t) => sum + t.capacityUnits, 0);
  const only = tables.length === 1 ? tables[0] : undefined;
  if (partySize > seats || (only !== undefined && partySize < only.minUnits)) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "The party does not fit those tables.", { reason: "party_size" });
  }
}

/**
 * Hold a slot. Resource choice: `resourceId`, several `resourceIds` (all needed at once), or none (the first
 * free eligible resource in name order). The hold expires `holdMinutes` after ctx.now().
 *
 * Concurrency: resource rows are locked in id order, then allocations are inserted in id order; the exclusion
 * constraint decides who wins and the loser gets BOOKING_SLOT_TAKEN. Idempotent per ctx.idempotencyKey.
 */
export async function createHold(
  sql: SqlClient,
  ctx: EngineContext,
  rawInput: unknown,
  options: EngineOptions = {},
): Promise<WriteResult> {
  return guarded(async () => {
    await assertScope(sql, ctx);
    const input = parseOrThrow(createHoldInputSchema, rawInput);
    const cfg = await loadConfig(sql, ctx, options);
    return withIdempotency(sql, ctx, "create_booking_hold", input, async () => {
      const source = options.availability ?? sqlAvailabilityDataSource;
      const service = input.catalogueItemId ? await loadService(sql, ctx, input.catalogueItemId, { requireAvailable: true }) : null;

      let durationMinutes: number;
      if (input.endsAt !== undefined) {
        const ms = Date.parse(input.endsAt) - Date.parse(input.startsAt);
        if (ms % 60_000 !== 0) throw new AppError(ErrorCode.VALIDATION_FAILED, "The booking length must be a whole number of minutes.");
        durationMinutes = ms / 60_000;
      } else {
        durationMinutes = input.durationMinutes ?? service?.durationMinutes ?? cfg.defaultDurationMinutes;
      }
      const startMs = Date.parse(input.startsAt);
      const endMs = startMs + durationMinutes * 60_000;
      const bufferMinutes = bufferFor(service, cfg);

      if (input.customerId !== undefined) await assertCustomerUsable(sql, ctx, input.customerId);

      const requested = input.resourceId !== undefined ? [input.resourceId] : input.resourceIds;
      const candidates = await source.listResources(sql, ctx, {
        ...(requested !== undefined ? { resourceIds: requested } : {}),
        catalogueItemId: service?.id ?? null,
        requiredType: service?.requiredResourceType ?? null,
        allowedTypes: cfg.pack.resourceTypes,
        partySize: input.partySize ?? null,
        fallbackTimezone: cfg.tenantTimezone,
      });

      let attempts: ResourceCandidate[][];
      if (requested !== undefined) {
        const byId = new Map(candidates.map((c) => [c.id, c]));
        const set = requested.map((id) => byId.get(id));
        if (set.some((r) => r === undefined)) throw new AppError(ErrorCode.NOT_FOUND, "Resource not found.", { entity: "resource" });
        const found = set as ResourceCandidate[];
        const bad = found.find((r) => !r.eligible);
        if (bad) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, "That resource cannot be booked for this.", {
            reason: "resource_not_eligible",
            detail: bad.reason ?? null,
          });
        }
        assertPartyFits(found, input.partySize);
        attempts = [found];
      } else {
        attempts = candidates.filter((c) => c.eligible).map((c) => [c]);
        if (attempts.length === 0) throw slotUnavailable("no_resource");
      }

      const reasons: string[] = [];
      for (const set of attempts) {
        try {
          const bookingId = await withSavepoint(sql, () =>
            holdOnce(sql, ctx, cfg, source, set, { startMs, endMs, bufferMinutes, input, serviceId: service?.id ?? null, currency: service?.currency ?? "INR" }),
          );
          const view = toView(await loadBooking(sql, ctx, bookingId));
          await recordChange(sql, ctx, BookingAuditAction.HOLD, view, null, { resourceIds: view.resourceIds, holdExpiresAt: view.holdExpiresAt });
          return { booking: view };
        } catch (err) {
          const t = translateDbError(err);
          if (t instanceof AppError && t.code === ErrorCode.BOOKING_SLOT_TAKEN) {
            reasons.push(String(t.details.reason ?? "taken"));
            continue;
          }
          throw t;
        }
      }
      // If every candidate failed for the same reason, say it; otherwise it simply was not free.
      const same = reasons.length > 0 && reasons.every((r) => r === reasons[0]);
      throw slotUnavailable(same ? (reasons[0] as WindowReason | "taken") : "taken");
    });
  });
}

interface HoldPlan {
  startMs: number;
  endMs: number;
  bufferMinutes: number;
  input: ReturnType<typeof createHoldInputSchema.parse>;
  serviceId: string | null;
  currency: string;
}

async function holdOnce(
  sql: SqlClient,
  ctx: EngineContext,
  cfg: BookingConfig,
  source: NonNullable<EngineOptions["availability"]>,
  set: readonly ResourceCandidate[],
  plan: HoldPlan,
): Promise<string> {
  // Lock first (id order), then check, then write: one consistent lock order for every caller.
  await lockResources(sql, ctx, set.map((r) => r.id));
  await assertWindowOpen(sql, ctx, cfg, source, set, plan.startMs, plan.endMs);

  const bookingId = ctx.newId();
  const expiresAt = new Date(ctx.now().getTime() + cfg.holdMinutes * 60_000);
  const first = [...set].sort((a, b) => (a.id < b.id ? -1 : 1))[0] as ResourceCandidate;
  await sql.query(
    `insert into bookings (id, tenant_id, location_id, customer_id, catalogue_item_id, status, source_channel,
                           starts_at, ends_at, party_size, notes, hold_expires_at, currency)
     values ($1, $2, $3, $4, $5, 'HOLD', $6, $7, $8, $9, $10, $11, $12)`,
    [
      bookingId,
      ctx.tenantId,
      first.locationId,
      plan.input.customerId ?? null,
      plan.serviceId,
      ctx.actor.channel,
      new Date(plan.startMs).toISOString(),
      new Date(plan.endMs).toISOString(),
      plan.input.partySize ?? null,
      plan.input.notes ?? null,
      expiresAt.toISOString(),
      plan.currency,
    ],
  );

  // An exclusive resource is occupied through its cleanup buffer; a shared one is occupied for the service time only.
  const rows = set.map((r) => {
    const exclusive = r.allocationMode === AllocationMode.EXCLUSIVE;
    return {
      resourceId: r.id,
      units: exclusive ? 1 : (plan.input.partySize ?? 1),
      startMs: plan.startMs,
      endMs: exclusive ? plan.endMs + plan.bufferMinutes * 60_000 : plan.endMs,
    };
  });
  await insertAllocations(sql, ctx, bookingId, rows, expiresAt);
  return bookingId;
}
