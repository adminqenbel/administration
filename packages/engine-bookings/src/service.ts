// The service being booked (catalogue item): duration, cleanup buffer, price and deposit.
import { toPaise } from "@qenbel/db";
import { AppError, ErrorCode, type EngineContext, type ResourceType, type SqlClient } from "@qenbel/shared";
import type { BookingConfig } from "./config.ts";
import { toInt } from "./util.ts";

export interface ServiceInfo {
  id: string;
  name: string;
  durationMinutes: number | null;
  bufferMinutes: number;
  pricePaise: number;
  currency: string;
  requiredResourceType: ResourceType | null;
  /** From attributes.depositPaise, when the business set one for this service. */
  depositPaise: number | null;
}

interface ItemRow {
  id: string;
  kind: string;
  name: string;
  duration_minutes: number | null;
  buffer_minutes: number;
  base_price_paise: string;
  currency: string;
  required_resource_type: ResourceType | null;
  attributes: unknown;
  available: boolean;
}

export async function loadService(sql: SqlClient, ctx: EngineContext, id: string, options: { requireAvailable: boolean }): Promise<ServiceInfo> {
  const res = await sql.query<ItemRow>(
    `select id, kind, name, duration_minutes, buffer_minutes, base_price_paise, currency, required_resource_type, attributes, available
       from catalogue_items where tenant_id = $1 and id = $2 and archived_at is null`,
    [ctx.tenantId, id],
  );
  const row = res.rows[0];
  if (!row || (options.requireAvailable && !row.available)) {
    throw new AppError(ErrorCode.NOT_FOUND, "Service not found.", { entity: "catalogue_item" });
  }
  if (row.kind !== "service") {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "That item cannot be booked.", { entity: "catalogue_item" });
  }
  const attrs = row.attributes !== null && typeof row.attributes === "object" ? (row.attributes as Record<string, unknown>) : {};
  const dep = attrs.depositPaise;
  return {
    id: row.id,
    name: row.name,
    durationMinutes: row.duration_minutes === null ? null : toInt(row.duration_minutes),
    bufferMinutes: toInt(row.buffer_minutes),
    pricePaise: toPaise(row.base_price_paise),
    currency: row.currency,
    requiredResourceType: row.required_resource_type,
    depositPaise: typeof dep === "number" && Number.isSafeInteger(dep) && dep >= 0 ? dep : null,
  };
}

/** Cleanup time after a booking: the larger of the service's own and the pack default. */
export function bufferFor(service: ServiceInfo | null, cfg: BookingConfig): number {
  return Math.max(service?.bufferMinutes ?? 0, cfg.defaultBufferMinutes);
}

/** Deposit in paise: the service's own setting, else the tenant's percentage or fixed amount of the price, else none. */
export function depositFor(service: ServiceInfo | null, cfg: BookingConfig): number {
  if (service?.depositPaise !== null && service?.depositPaise !== undefined) return service.depositPaise;
  if (cfg.deposit.percentBps !== null && service) {
    const v = (BigInt(service.pricePaise) * BigInt(cfg.deposit.percentBps) + 5000n) / 10000n;
    return Number(v);
  }
  if (cfg.deposit.fixedPaise !== null) return cfg.deposit.fixedPaise;
  return 0;
}
