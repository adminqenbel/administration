// check_availability: free slots per resource over a date range.
import {
  AppError,
  ErrorCode,
  addDays,
  availabilityQuerySchema,
  eachLocalDate,
  localDateOf,
  type EngineContext,
  type SqlClient,
} from "@qenbel/shared";
import { slotsForResource } from "./availability-core.ts";
import { loadConfig, type EngineOptions } from "./config.ts";
import { sqlAvailabilityDataSource } from "./sql-source.ts";
import { bufferFor, loadService } from "./service.ts";
import type { AvailabilityResourceView, AvailabilityResult, AvailabilitySlotView } from "./types.ts";
import { customerRulesApply } from "./window.ts";
import { assertScope, guarded } from "./util.ts";
import { parseOrThrow } from "./schemas.ts";

const MS_DAY = 86_400_000;

/**
 * Open slots for a service (or a raw duration) over `from`..`to` (local dates, inclusive, at most 14 days).
 * Honours opening hours, holidays, the resource's own schedule, breaks, time off, the service's cleanup buffer,
 * live bookings and unexpired holds, lead time and maximum advance, resource eligibility, and shared capacity.
 * Returns times only: never who holds a slot or any customer detail.
 */
export async function checkAvailability(
  sql: SqlClient,
  ctx: EngineContext,
  rawInput: unknown,
  options: EngineOptions = {},
): Promise<AvailabilityResult> {
  return guarded(async () => {
    await assertScope(sql, ctx);
    const input = parseOrThrow(availabilityQuerySchema, rawInput);
    const cfg = await loadConfig(sql, ctx, options);
    const source = options.availability ?? sqlAvailabilityDataSource;

    const service = input.catalogueItemId ? await loadService(sql, ctx, input.catalogueItemId, { requireAvailable: true }) : null;
    const durationMinutes = input.durationMinutes ?? service?.durationMinutes ?? cfg.defaultDurationMinutes;
    const bufferMinutes = bufferFor(service, cfg);

    const candidates = await source.listResources(sql, ctx, {
      ...(input.resourceId !== undefined ? { resourceIds: [input.resourceId] } : {}),
      catalogueItemId: service?.id ?? null,
      requiredType: service?.requiredResourceType ?? null,
      allowedTypes: cfg.pack.resourceTypes,
      partySize: input.partySize ?? null,
      fallbackTimezone: cfg.tenantTimezone,
    });
    if (input.resourceId !== undefined && candidates.length === 0) {
      throw new AppError(ErrorCode.NOT_FOUND, "Resource not found.", { entity: "resource" });
    }
    const eligible = candidates.filter((c) => c.eligible);

    const toDate = input.to ?? input.from;
    const dates = eachLocalDate(input.from, toDate);
    const nowMs = ctx.now().getTime();
    const inputsList = await source.loadInputs(sql, ctx, eligible, {
      // Wide enough for any zone: dates are local to each resource's location.
      from: new Date(Date.parse(`${input.from}T00:00:00Z`) - 2 * MS_DAY),
      to: new Date(Date.parse(`${toDate}T00:00:00Z`) + 3 * MS_DAY),
      fromDate: addDays(input.from, -1),
      toDate: addDays(toDate, 1),
    });

    const customerRules = customerRulesApply(ctx);
    const notBefore = customerRules ? new Date(nowMs + cfg.leadTimeMinutes * 60_000).toISOString() : new Date(nowMs).toISOString();
    const views: AvailabilityResourceView[] = [];
    const flat: AvailabilitySlotView[] = [];
    for (const inputs of inputsList) {
      const tz = inputs.resource.timezone;
      const lastDate = customerRules ? addDays(localDateOf(nowMs, tz), cfg.maxAdvanceDays) : null;
      const slots = slotsForResource(inputs, dates, {
        durationMinutes,
        bufferMinutes,
        stepMinutes: cfg.stepMinutes,
        units: input.partySize ?? 1,
        notBefore,
        lastDate,
        defaultHours: cfg.pack.defaults.hours,
        defaultBreaks: cfg.breaks,
      });
      const mapped = slots.map((s) => ({ startsAt: s.start, endsAt: s.end }));
      views.push({ resourceId: inputs.resource.id, resourceName: inputs.resource.name, timezone: tz, slots: mapped });
      for (const s of mapped) flat.push({ ...s, resourceId: inputs.resource.id, resourceName: inputs.resource.name });
    }
    flat.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.resourceName.localeCompare(b.resourceName) || a.resourceId.localeCompare(b.resourceId));
    return { timezone: views[0]?.timezone ?? cfg.tenantTimezone, slots: flat, resources: views };
  });
}
