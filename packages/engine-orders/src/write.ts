// Write helpers shared by the draft, lifecycle and payment modules: locking with the optimistic version check,
// repricing a draft, inserting lines and fulfilments.
import { toPaise } from "@qenbel/db";
import {
  AppError,
  ErrorCode,
  FulfilmentStatus,
  FulfilmentType,
  OrderStatus,
  type EngineContext,
  type Paise,
  type SqlClient,
} from "@qenbel/shared";
import { orderError } from "./common.ts";
import { requireTable, type ResolvedLine } from "./lookups.ts";
import type { FulfilmentInput } from "./schemas.ts";
import {
  DISCOUNT_APPROVAL_CAP_BPS,
  computeTotals,
  discountAmount,
  discountBpsOfSubtotal,
  specFromStored,
  specToStored,
  type DiscountSpec,
} from "./totals.ts";
import { loadFulfilmentRow, loadItemRows, loadOrderRow, type ItemRow, type OrderRow } from "./view.ts";
import { money } from "./common.ts";

/** Lock the order row, then check the caller's version. A stale version changes nothing: VERSION_CONFLICT. */
export async function lockOrder(
  sql: SqlClient,
  ctx: EngineContext,
  orderId: string,
  expectedVersion: number | undefined,
): Promise<OrderRow> {
  const row = await loadOrderRow(sql, ctx, orderId, true);
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw new AppError(ErrorCode.VERSION_CONFLICT, undefined, {
      reason: "ORDER_VERSION_CONFLICT",
      expectedVersion,
      currentVersion: row.version,
    });
  }
  return row;
}

export function invalidState(row: OrderRow, wanted: string): AppError {
  return new AppError(ErrorCode.INVALID_TRANSITION, `The order is ${row.status}; ${wanted}.`, {
    reason: "ORDER_INVALID_STATE",
    status: row.status,
  });
}

export function assertDraft(row: OrderRow): void {
  if (row.status !== OrderStatus.DRAFT) throw invalidState(row, "only a draft can be edited");
}

/** Insert one priced line, freezing the catalogue's tax rate on it. created_at uses clock_timestamp() so lines keep their insertion order within a transaction. */
export async function insertItem(
  sql: SqlClient,
  ctx: EngineContext,
  orderId: string,
  line: ResolvedLine,
  taxPaise: Paise,
): Promise<string> {
  const id = ctx.newId();
  const linePaise = money(() => line.unitPricePaise * line.quantity);
  await sql.query(
    `insert into order_items
       (id, tenant_id, order_id, catalogue_item_id, variant_id, name, quantity, unit_price_paise, tax_rate_bps, tax_paise, line_total_paise, notes, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, clock_timestamp())`,
    [id, ctx.tenantId, orderId, line.catalogueItemId, line.variantId, line.name, line.quantity, line.unitPricePaise, line.taxRateBps, taxPaise, linePaise, line.note],
  );
  return id;
}

/** A discount as the engine holds it: the spec plus why and whether the cap was overridden. */
export interface DiscountSetting {
  spec: DiscountSpec;
  reason: string | null;
  capOverride: boolean;
}

/** The discount spec persisted on the order row, or null. */
export function storedDiscount(order: OrderRow): DiscountSetting | null {
  if (order.discount_type === null || order.discount_value === null) return null;
  return {
    spec: specFromStored(order.discount_type, toPaise(order.discount_value)),
    reason: order.discount_reason,
    capOverride: order.discount_cap_override,
  };
}

export interface RepriceResult {
  order: OrderRow;
  /** True when a stored discount no longer fitted the edited lines and was removed. */
  discountCleared: boolean;
}

/**
 * Recompute and store the totals of a DRAFT from its stored lines. Unit prices AND tax rates are the snapshots on the
 * lines (order_items.unit_price_paise / tax_rate_bps): the catalogue is not read. Line tax_paise and the order totals
 * are rewritten and the version rises by one.
 *
 * Discount: `change` omitted means KEEP the stored spec (discount_type/value) and recompute the amount from the new
 * subtotal, so line edits never silently drop a discount. `change.discount` replaces it (null removes it); the caller
 * has already validated an explicit change. A KEPT spec that has become invalid is removed and `discountCleared` is
 * true: a fixed discount larger than the new subtotal, or one above DISCOUNT_APPROVAL_CAP_BPS of the new subtotal
 * that was never approved with the override flag. (A percent spec cannot go over the cap by itself.)
 */
export async function repriceDraft(
  sql: SqlClient,
  ctx: EngineContext,
  order: OrderRow,
  change?: { discount: DiscountSetting | null },
): Promise<RepriceResult> {
  const items = await loadItemRows(sql, ctx, order.id);
  const lines = items.map((i) => ({
    quantity: i.quantity,
    unitPricePaise: toPaise(i.unit_price_paise),
    taxRateBps: i.tax_rate_bps,
  }));
  let setting: DiscountSetting | null = change ? change.discount : storedDiscount(order);
  let discountCleared = false;
  if (setting && !change) {
    const subtotal = money(() => computeTotals(lines, null).subtotalPaise);
    let keep = true;
    try {
      const amount = discountAmount(subtotal, setting.spec);
      if (!setting.capOverride && discountBpsOfSubtotal(amount, subtotal) > DISCOUNT_APPROVAL_CAP_BPS) keep = false;
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      keep = false;
    }
    if (!keep) {
      setting = null;
      discountCleared = true;
    }
  }
  const totals = money(() => computeTotals(lines, setting?.spec ?? null));
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx] as ItemRow;
    const tax = (totals.lines[idx] as { taxPaise: Paise }).taxPaise;
    if (toPaise(item.tax_paise) !== tax) {
      await sql.query("update order_items set tax_paise = $3 where tenant_id = $1 and id = $2", [ctx.tenantId, item.id, tax]);
    }
  }
  const stored = setting ? specToStored(setting.spec) : null;
  const res = await sql.query<OrderRow>(
    `update orders
        set subtotal_paise = $3, tax_paise = $4, discount_paise = $5, total_paise = $6,
            discount_type = $8, discount_value = $9, discount_reason = $10, discount_cap_override = $11,
            version = version + 1
      where tenant_id = $1 and id = $2 and version = $7
      returning *`,
    [
      ctx.tenantId,
      order.id,
      totals.subtotalPaise,
      totals.taxPaise,
      totals.discountPaise,
      totals.totalPaise,
      order.version,
      stored?.type ?? null,
      stored?.value ?? null,
      stored ? (setting?.reason ?? null) : null,
      stored ? (setting?.capOverride ?? false) : false,
    ],
  );
  const updated = res.rows[0];
  if (!updated) throw new AppError(ErrorCode.VERSION_CONFLICT, undefined, { reason: "ORDER_VERSION_CONFLICT" });
  return { order: updated, discountCleared };
}

/** Bump the version without touching anything else (fulfilment or link changes). */
export async function bumpVersion(sql: SqlClient, ctx: EngineContext, order: OrderRow): Promise<OrderRow> {
  const res = await sql.query<OrderRow>(
    "update orders set version = version + 1 where tenant_id = $1 and id = $2 and version = $3 returning *",
    [ctx.tenantId, order.id, order.version],
  );
  const updated = res.rows[0];
  if (!updated) throw new AppError(ErrorCode.VERSION_CONFLICT, undefined, { reason: "ORDER_VERSION_CONFLICT" });
  return updated;
}

/**
 * Validate and store the fulfilment (one per order: an existing row is replaced in place). Also sets `orders.resource_id`
 * (the dine-in table; null for every other type or a label-only table). The fulfilment keeps only the human label.
 * Does not bump the order version: the caller does.
 */
export async function upsertFulfilment(
  sql: SqlClient,
  ctx: EngineContext,
  orderId: string,
  input: FulfilmentInput,
  /** Table resource implied by the draft's top-level resourceId, merged into a dine-in fulfilment. */
  impliedTableId?: string,
): Promise<void> {
  let address: Record<string, unknown> | null = null;
  let tableResourceId: string | null = null;
  let scheduledFor: string | null = null;
  let notes: string | null = null;
  switch (input.type) {
    case FulfilmentType.PICKUP:
      scheduledFor = input.scheduledFor ?? null;
      notes = input.notes ?? null;
      break;
    case FulfilmentType.DELIVERY:
      address = { ...input.address };
      scheduledFor = input.scheduledFor ?? null;
      notes = input.notes ?? null;
      break;
    case FulfilmentType.DINE_IN: {
      const resourceId = input.resourceId ?? impliedTableId;
      if (input.resourceId && impliedTableId && input.resourceId !== impliedTableId) {
        throw orderError(ErrorCode.VALIDATION_FAILED, "TABLE_CONFLICT", "Two different tables were given.");
      }
      if (!resourceId && !input.tableLabel) {
        throw orderError(ErrorCode.REQUIRED_FIELDS_MISSING, "TABLE_REQUIRED", "Give a table.", { missing: ["tableLabel"] });
      }
      let label = input.tableLabel;
      if (resourceId) {
        const table = await requireTable(sql, ctx, resourceId);
        label = label ?? table.name;
        address = { tableLabel: label };
        tableResourceId = table.id;
      } else {
        address = { tableLabel: label };
      }
      notes = input.notes ?? null;
      break;
    }
    case FulfilmentType.ON_SITE:
      address = input.place ? { place: input.place } : null;
      scheduledFor = input.scheduledFor ?? null;
      notes = input.notes ?? null;
      break;
  }
  await sql.query("update orders set resource_id = $3 where tenant_id = $1 and id = $2", [ctx.tenantId, orderId, tableResourceId]);
  const status = scheduledFor ? FulfilmentStatus.SCHEDULED : FulfilmentStatus.PENDING;
  const existing = await loadFulfilmentRow(sql, ctx, orderId);
  if (existing) {
    await sql.query(
      `update fulfilments set type = $3, status = $4, address = $5::jsonb, scheduled_for = $6, notes = $7, completed_at = null
        where tenant_id = $1 and id = $2`,
      [ctx.tenantId, existing.id, input.type, status, address === null ? null : JSON.stringify(address), scheduledFor, notes],
    );
  } else {
    await sql.query(
      `insert into fulfilments (id, tenant_id, order_id, type, status, address, scheduled_for, notes)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [ctx.newId(), ctx.tenantId, orderId, input.type, status, address === null ? null : JSON.stringify(address), scheduledFor, notes],
    );
  }
}
