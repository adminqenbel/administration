// Row types, loaders and the OrderView returned by every engine function. Money leaves as integer paise (numbers,
// checked safe); timestamps leave as ISO strings.
import { toPaise } from "@qenbel/db";
import {
  FulfilmentType,
  type Channel,
  type EngineContext,
  type FulfilmentStatus,
  type OrderStatus,
  type Paise,
  type PaymentStatus,
  type SqlClient,
} from "@qenbel/shared";
import { notFound } from "./common.ts";
import { netPaidPaise, outstandingPaise, type LedgerSums } from "./ledger.ts";
import type { PackContext } from "./pack.ts";

export interface OrderRow {
  id: string;
  reference: string;
  location_id: string | null;
  customer_id: string | null;
  booking_id: string | null;
  status: OrderStatus;
  version: number;
  source_channel: Channel;
  payment_status: PaymentStatus;
  subtotal_paise: string;
  tax_paise: string;
  discount_paise: string;
  total_paise: string;
  currency: string;
  notes: string | null;
  placed_at: Date | null;
  fulfilled_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ItemRow {
  id: string;
  order_id: string;
  catalogue_item_id: string | null;
  variant_id: string | null;
  name: string;
  quantity: number;
  unit_price_paise: string;
  tax_paise: string;
  line_total_paise: string;
  notes: string | null;
}

export interface FulfilmentRow {
  id: string;
  order_id: string;
  type: FulfilmentType;
  status: FulfilmentStatus;
  address: Record<string, unknown> | null;
  scheduled_for: Date | null;
  completed_at: Date | null;
  notes: string | null;
}

export interface OrderItemView {
  id: string;
  catalogueItemId: string | null;
  variantId: string | null;
  name: string;
  quantity: number;
  unitPricePaise: Paise;
  taxPaise: Paise;
  linePaise: Paise;
  note: string | null;
}

export interface FulfilmentView {
  id: string;
  type: FulfilmentType;
  status: FulfilmentStatus;
  /** Delivery address, or { place } for on_site. Null for pickup. Dine-in uses tableLabel/resourceId instead. */
  address: Record<string, unknown> | null;
  tableLabel: string | null;
  resourceId: string | null;
  scheduledFor: string | null;
  completedAt: string | null;
  notes: string | null;
}

export interface PaymentSummary {
  paidPaise: Paise;
  refundedPaise: Paise;
  /** Payments minus refunds: the money held against this order. */
  netPaidPaise: Paise;
  outstandingPaise: Paise;
}

export interface OrderView {
  id: string;
  reference: string;
  status: OrderStatus;
  /** The pack's word for the status ("Preparing"). */
  statusLabel: string;
  /** Statuses the pack allows next (drives one-click actions). */
  allowedNext: OrderStatus[];
  customerId: string | null;
  bookingId: string | null;
  /** The table resource of a dine-in fulfilment, if any. */
  resourceId: string | null;
  items: OrderItemView[];
  subtotalPaise: Paise;
  discountPaise: Paise;
  taxPaise: Paise;
  totalPaise: Paise;
  currency: string;
  paymentStatus: PaymentStatus;
  payment: PaymentSummary;
  fulfilment: FulfilmentView | null;
  notes: string | null;
  source: Channel;
  version: number;
  placedAt: string | null;
  fulfilledAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** Things the caller should know, for example "DISCOUNT_CLEARED" after an item change. */
  notices: string[];
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function itemView(row: ItemRow): OrderItemView {
  return {
    id: row.id,
    catalogueItemId: row.catalogue_item_id,
    variantId: row.variant_id,
    name: row.name,
    quantity: row.quantity,
    unitPricePaise: toPaise(row.unit_price_paise),
    taxPaise: toPaise(row.tax_paise),
    linePaise: toPaise(row.line_total_paise),
    note: row.notes,
  };
}

export function fulfilmentView(row: FulfilmentRow): FulfilmentView {
  const addr = row.address;
  const dineIn = row.type === FulfilmentType.DINE_IN;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    address: dineIn ? null : addr,
    tableLabel: dineIn && typeof addr?.tableLabel === "string" ? addr.tableLabel : null,
    resourceId: dineIn && typeof addr?.resourceId === "string" ? addr.resourceId : null,
    scheduledFor: iso(row.scheduled_for),
    completedAt: iso(row.completed_at),
    notes: row.notes,
  };
}

// ---- loaders ---------------------------------------------------------------------------------------------

/** Load an order row, optionally locking it (`for update`) so concurrent writers on one order are serialised. */
export async function loadOrderRow(sql: SqlClient, ctx: EngineContext, orderId: string, lock: boolean): Promise<OrderRow> {
  const res = await sql.query<OrderRow>(
    `select * from orders where tenant_id = $1 and id = $2${lock ? " for update" : ""}`,
    [ctx.tenantId, orderId],
  );
  const row = res.rows[0];
  if (!row) throw notFound("ORDER_NOT_FOUND");
  return row;
}

export async function loadItemRows(sql: SqlClient, ctx: EngineContext, orderId: string): Promise<ItemRow[]> {
  const res = await sql.query<ItemRow>(
    "select * from order_items where tenant_id = $1 and order_id = $2 order by created_at, id",
    [ctx.tenantId, orderId],
  );
  return res.rows;
}

export async function loadFulfilmentRow(sql: SqlClient, ctx: EngineContext, orderId: string): Promise<FulfilmentRow | null> {
  const res = await sql.query<FulfilmentRow>(
    "select * from fulfilments where tenant_id = $1 and order_id = $2 order by created_at desc, id limit 1",
    [ctx.tenantId, orderId],
  );
  return res.rows[0] ?? null;
}

/** Sums of COMPLETED ledger entries for one order. */
export async function loadLedgerSums(sql: SqlClient, ctx: EngineContext, orderId: string): Promise<LedgerSums> {
  const res = await sql.query<{ paid: string; refunded: string }>(
    `select coalesce(sum(amount_paise) filter (where kind = 'payment'), 0) as paid,
            coalesce(sum(amount_paise) filter (where kind = 'refund'), 0) as refunded
       from payments where tenant_id = $1 and order_id = $2 and status = 'completed'`,
    [ctx.tenantId, orderId],
  );
  const row = res.rows[0];
  return { paidPaise: toPaise(row?.paid ?? "0"), refundedPaise: toPaise(row?.refunded ?? "0") };
}

export function paymentSummary(totalPaise: Paise, sums: LedgerSums): PaymentSummary {
  return {
    paidPaise: sums.paidPaise,
    refundedPaise: sums.refundedPaise,
    netPaidPaise: netPaidPaise(sums),
    outstandingPaise: outstandingPaise(totalPaise, sums),
  };
}

/** Build the full view of an order from the database (re-reads items, fulfilment and ledger). */
export async function buildOrderView(
  sql: SqlClient,
  ctx: EngineContext,
  packCtx: PackContext,
  row: OrderRow,
  notices: string[] = [],
): Promise<OrderView> {
  // Sequential on purpose: one pg client runs one query at a time.
  const items = await loadItemRows(sql, ctx, row.id);
  const fulfilment = await loadFulfilmentRow(sql, ctx, row.id);
  const sums = await loadLedgerSums(sql, ctx, row.id);
  const totalPaise = toPaise(row.total_paise);
  const f = fulfilment ? fulfilmentView(fulfilment) : null;
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    statusLabel: packCtx.label(row.status),
    allowedNext: packCtx.nextStatuses(row.status),
    customerId: row.customer_id,
    bookingId: row.booking_id,
    resourceId: f?.resourceId ?? null,
    items: items.map(itemView),
    subtotalPaise: toPaise(row.subtotal_paise),
    discountPaise: toPaise(row.discount_paise),
    taxPaise: toPaise(row.tax_paise),
    totalPaise,
    currency: row.currency,
    paymentStatus: row.payment_status,
    payment: paymentSummary(totalPaise, sums),
    fulfilment: f,
    notes: row.notes,
    source: row.source_channel,
    version: row.version,
    placedAt: iso(row.placed_at),
    fulfilledAt: iso(row.fulfilled_at),
    cancelledAt: iso(row.cancelled_at),
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    notices,
  };
}
