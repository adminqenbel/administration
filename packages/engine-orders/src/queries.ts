// Reads: one order, the channel-safe status view, filtered pages, and the board by status.
import { toPaise } from "@qenbel/db";
import { ErrorCode, OrderStatus, type Channel, type EngineContext, type Paise, type PaymentStatus, type SqlClient } from "@qenbel/shared";
import { assertTenantSession, notFound, orderError, parseInput } from "./common.ts";
import { loadPackContext } from "./pack.ts";
import { actsForCustomer, assertOwnsOrder, limitsFor, requireStaff, requireSubject, subjectCustomerId } from "./scope.ts";
import {
  getOrderInputSchema,
  listOrdersInputSchema,
  orderBoardInputSchema,
  orderStatusForChannelInputSchema,
  type GetOrderInput,
  type ListOrdersInput,
  type OrderBoardInput,
  type OrderStatusForChannelInput,
} from "./schemas.ts";
import { buildOrderView, loadItemRows, loadOrderRow, type OrderRow, type OrderView } from "./view.ts";

export async function getOrder(sql: SqlClient, ctx: EngineContext, rawInput: GetOrderInput): Promise<OrderView> {
  const input = parseInput(getOrderInputSchema, rawInput);
  await assertTenantSession(sql, ctx);
  const packCtx = await loadPackContext(sql, ctx, false);
  const row = await loadOrderRow(sql, ctx, input.orderId, false);
  assertOwnsOrder(ctx, row);
  return buildOrderView(sql, ctx, packCtx, row);
}

// ---- channel-safe status -------------------------------------------------------------------------------------

/** The only fields an AI or WhatsApp channel may see about an order. No notes, contacts, payments or other orders. */
export interface ChannelOrderStatus {
  orderId: string;
  reference: string;
  status: OrderStatus;
  statusLabel: string;
  paymentStatus: PaymentStatus;
  lines: {
    catalogueItemId: string | null;
    name: string;
    quantity: number;
    unitAmountPaise: Paise;
    lineAmountPaise: Paise;
    notes?: string;
  }[];
  totalAmountPaise: Paise;
  currency: string;
  version: number;
  updatedAt: string;
}

/**
 * Status of ONE order for the verified customer in `ctx.subject.customerId` (set by the channel layer from the verified
 * contact, never from the model). Fails closed on every channel: no subject, an order that belongs to someone else, an
 * order with no customer, a prefix of a reference and a non-existent order all return the same NOT_FOUND body, so the
 * channel cannot probe for other customers' orders.
 */
export async function getOrderStatusForChannel(
  sql: SqlClient,
  ctx: EngineContext,
  rawInput: OrderStatusForChannelInput,
): Promise<ChannelOrderStatus> {
  const input = parseInput(orderStatusForChannelInputSchema, rawInput);
  await assertTenantSession(sql, ctx);
  const customerId = subjectCustomerId(ctx);
  if (customerId === undefined) throw notFound("ORDER_NOT_FOUND");
  const packCtx = await loadPackContext(sql, ctx, false);
  const res = input.orderId
    ? await sql.query<OrderRow>("select * from orders where tenant_id = $1 and customer_id = $2 and id = $3", [ctx.tenantId, customerId, input.orderId])
    : await sql.query<OrderRow>("select * from orders where tenant_id = $1 and customer_id = $2 and upper(reference) = upper($3)", [
        ctx.tenantId,
        customerId,
        input.orderReference as string,
      ]);
  const order = res.rows[0];
  if (!order) throw notFound("ORDER_NOT_FOUND");
  const items = await loadItemRows(sql, ctx, order.id);
  return {
    orderId: order.id,
    reference: order.reference,
    status: order.status,
    statusLabel: packCtx.label(order.status),
    paymentStatus: order.payment_status,
    lines: items.map((i) => ({
      catalogueItemId: i.catalogue_item_id,
      name: i.name,
      quantity: i.quantity,
      unitAmountPaise: toPaise(i.unit_price_paise),
      lineAmountPaise: toPaise(i.line_total_paise),
      ...(i.notes ? { notes: i.notes } : {}),
    })),
    totalAmountPaise: toPaise(order.total_paise),
    currency: order.currency,
    version: order.version,
    updatedAt: order.updated_at.toISOString(),
  };
}

// ---- lists ---------------------------------------------------------------------------------------------------

export interface OrderSummary {
  id: string;
  reference: string;
  status: OrderStatus;
  statusLabel: string;
  customerId: string | null;
  customerName: string | null;
  itemCount: number;
  totalPaise: Paise;
  currency: string;
  paymentStatus: PaymentStatus;
  source: Channel;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface SummaryRow extends OrderRow {
  customer_name: string | null;
  item_count: string;
  created_at_raw: string;
}

const SUMMARY_COLUMNS = `o.*, c.name as customer_name,
  (select coalesce(sum(i.quantity), 0) from order_items i where i.tenant_id = o.tenant_id and i.order_id = o.id) as item_count,
  to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_raw`;

function summaryOf(row: SummaryRow, label: (s: OrderStatus) => string): OrderSummary {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    statusLabel: label(row.status),
    customerId: row.customer_id,
    customerName: row.customer_name,
    itemCount: Number(row.item_count),
    totalPaise: toPaise(row.total_paise),
    currency: row.currency,
    paymentStatus: row.payment_status,
    source: row.source_channel,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function encodeCursor(createdAtRaw: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAtRaw, id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { t: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
    if (
      typeof parsed.t === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.t) &&
      typeof parsed.id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.id)
    ) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // fall through
  }
  throw orderError(ErrorCode.VALIDATION_FAILED, "CURSOR_INVALID", "The page cursor is not valid.");
}

export interface OrderPage {
  items: OrderSummary[];
  nextCursor: string | null;
}

/** Newest first, stable paging by (created_at, id). Filters: status, customer, created from/to, channel, payment status, reference. */
export async function listOrders(sql: SqlClient, ctx: EngineContext, rawInput: ListOrdersInput = {}): Promise<OrderPage> {
  const parsed = parseInput(listOrdersInputSchema, rawInput);
  await assertTenantSession(sql, ctx);
  // A customer sees only their own orders, in small pages; staff see the tenant's, in pages of at most 100.
  const input = { ...parsed, limit: Math.min(parsed.limit, limitsFor(ctx).maxListLimit) };
  if (actsForCustomer(ctx)) {
    const subject = requireSubject(ctx);
    if (input.customerId !== undefined && input.customerId !== subject) throw notFound("ORDER_NOT_FOUND");
    input.customerId = subject;
  }
  const packCtx = await loadPackContext(sql, ctx, false);
  const where: string[] = ["o.tenant_id = $1"];
  const params: unknown[] = [ctx.tenantId];
  const add = (sqlText: string, value: unknown): void => {
    params.push(value);
    where.push(sqlText.replace("?", `$${params.length}`));
  };
  if (input.status) add("o.status = ?", input.status);
  if (input.customerId) add("o.customer_id = ?", input.customerId);
  if (input.from) add("o.created_at >= ?::timestamptz", input.from);
  if (input.to) add("o.created_at < ?::timestamptz", input.to);
  if (input.channel) add("o.source_channel = ?", input.channel);
  if (input.paymentStatus) add("o.payment_status = ?", input.paymentStatus);
  if (input.reference) add("upper(o.reference) = upper(?)", input.reference);
  if (input.cursor) {
    const c = decodeCursor(input.cursor);
    params.push(c.t, c.id);
    where.push(`(o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(input.limit + 1);
  const res = await sql.query<SummaryRow>(
    `select ${SUMMARY_COLUMNS}
       from orders o left join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id
      where ${where.join(" and ")}
      order by o.created_at desc, o.id desc
      limit $${params.length}`,
    params,
  );
  const hasMore = res.rows.length > input.limit;
  const rows = hasMore ? res.rows.slice(0, input.limit) : res.rows;
  const last = rows[rows.length - 1];
  return {
    items: rows.map((r) => summaryOf(r, packCtx.label)),
    nextCursor: hasMore && last ? encodeCursor(last.created_at_raw, last.id) : null,
  };
}

export interface OrderBoardColumn {
  status: OrderStatus;
  label: string;
  count: number;
  /** Oldest first, as a kitchen wants them. */
  orders: OrderSummary[];
}

/** The orders board: one column per requested status (default: the live ones), with true counts. */
export async function getOrderBoard(sql: SqlClient, ctx: EngineContext, rawInput: OrderBoardInput = {}): Promise<OrderBoardColumn[]> {
  const input = parseInput(orderBoardInputSchema, rawInput);
  requireStaff(ctx, "getOrderBoard");
  await assertTenantSession(sql, ctx);
  const packCtx = await loadPackContext(sql, ctx, false);
  const statuses: OrderStatus[] =
    input.statuses ?? [OrderStatus.PLACED, OrderStatus.ACCEPTED, OrderStatus.PROCESSING, OrderStatus.READY];
  const columns: OrderBoardColumn[] = [];
  for (const status of statuses) {
    const count = await sql.query<{ n: string }>("select count(*) as n from orders where tenant_id = $1 and status = $2", [ctx.tenantId, status]);
    const rows = await sql.query<SummaryRow>(
      `select ${SUMMARY_COLUMNS}
         from orders o left join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id
        where o.tenant_id = $1 and o.status = $2
        order by o.created_at, o.id
        limit $3`,
      [ctx.tenantId, status, input.limitPerStatus],
    );
    columns.push({
      status,
      label: packCtx.label(status),
      count: Number(count.rows[0]?.n ?? 0),
      orders: rows.rows.map((r) => summaryOf(r, packCtx.label)),
    });
  }
  return columns;
}
