// "Is this exact window open for booking?" for holds and reschedules: opening hours, holidays, breaks, time off,
// lead time and maximum advance. Conflicts with other bookings are NOT checked here: the database constraint is the
// single authority on that (and it is race-free). Uses the same slot code as availability, so the two cannot disagree.
import { AppError, ErrorCode, addDays, localDateOf, type EngineContext, type SqlClient } from "@qenbel/shared";
import { slotsForResource } from "./availability-core.ts";
import type { AvailabilityDataSource, ResourceSummary } from "./availability-source.ts";
import type { BookingConfig } from "./config.ts";

export type WindowReason = "in_the_past" | "outside_hours" | "lead_time" | "too_far_ahead";

const MS_DAY = 86_400_000;

/** Customer-facing channels get lead time and maximum advance; the dashboard (staff) does not. */
export function customerRulesApply(ctx: EngineContext): boolean {
  return ctx.actor.channel !== "dashboard";
}

export async function assertWindowOpen(
  sql: SqlClient,
  ctx: EngineContext,
  cfg: BookingConfig,
  source: AvailabilityDataSource,
  resources: readonly ResourceSummary[],
  startMs: number,
  endMs: number,
): Promise<void> {
  const nowMs = ctx.now().getTime();
  if (startMs < nowMs) throw slotUnavailable("in_the_past");

  const durationMs = endMs - startMs;
  const durationMinutes = durationMs / 60_000;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "The booking length must be a whole number of minutes.");
  }
  const customerRules = customerRulesApply(ctx);
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  for (const resource of resources) {
    const date = localDateOf(startMs, resource.timezone);
    const [inputs] = await source.loadInputs(sql, ctx, [resource], {
      from: new Date(startMs - MS_DAY),
      to: new Date(endMs + MS_DAY),
      fromDate: date,
      toDate: date,
    });
    if (!inputs) throw slotUnavailable("outside_hours");

    const lastDate = customerRules ? addDays(localDateOf(nowMs, resource.timezone), cfg.maxAdvanceDays) : null;
    const notBefore = customerRules ? new Date(nowMs + cfg.leadTimeMinutes * 60_000).toISOString() : null;
    const base = {
      durationMinutes,
      bufferMinutes: 0,
      stepMinutes: 1,
      defaultHours: cfg.pack.defaults.hours,
      defaultBreaks: cfg.breaks,
      ignoreAllocations: true,
    };
    const fits = (slots: { start: string; end: string }[]) => slots.some((s) => s.start === startIso && s.end === endIso);

    if (fits(slotsForResource(inputs, [date], { ...base, notBefore, lastDate }))) continue;

    // Say why, so the caller can offer something sensible.
    if (fits(slotsForResource(inputs, [date], { ...base, notBefore: null, lastDate: null }))) {
      throw slotUnavailable(lastDate !== null && date > lastDate ? "too_far_ahead" : "lead_time");
    }
    throw slotUnavailable("outside_hours");
  }
}

export function slotUnavailable(reason: WindowReason | "taken" | "no_resource"): AppError {
  return new AppError(ErrorCode.BOOKING_SLOT_TAKEN, undefined, { reason });
}
