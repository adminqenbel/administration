// Ledger primitives on the payments table (insert-only for the app role). Used by payments.ts and by the
// lifecycle code, which writes a refund entry when a paid order is cancelled or rejected.
import { toPaise } from "@qenbel/db";
import {
  PaymentEntryStatus,
  PaymentKind,
  type EngineContext,
  type Paise,
  type PaymentMethod,
  type SqlClient,
} from "@qenbel/shared";
import { emitEvent } from "./common.ts";
import { derivePaymentStatus } from "./ledger.ts";
import { loadLedgerSums, type OrderRow } from "./view.ts";

export interface PaymentEntryView {
  id: string;
  orderId: string;
  kind: PaymentKind;
  method: PaymentMethod;
  status: PaymentEntryStatus;
  amountPaise: Paise;
  currency: string;
  provider: string | null;
  providerReference: string | null;
  note: string | null;
  occurredAt: string;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  kind: PaymentKind;
  method: PaymentMethod;
  status: PaymentEntryStatus;
  amount_paise: string;
  currency: string;
  provider: string | null;
  provider_reference: string | null;
  note: string | null;
  occurred_at: Date;
}

export function paymentEntryView(row: PaymentRow): PaymentEntryView {
  return {
    id: row.id,
    orderId: row.order_id,
    kind: row.kind,
    method: row.method,
    status: row.status,
    amountPaise: toPaise(row.amount_paise),
    currency: row.currency,
    provider: row.provider,
    providerReference: row.provider_reference,
    note: row.note,
    occurredAt: row.occurred_at.toISOString(),
  };
}

export interface NewEntry {
  kind: PaymentKind;
  method: PaymentMethod;
  amountPaise: Paise;
  note?: string | null;
  provider?: string | null;
  providerReference?: string | null;
}

/**
 * Insert one COMPLETED ledger entry for an order (caller holds the order row lock), queue `payment.completed`
 * (payload.kind says payment or refund) and return the entry. Does not touch the order row.
 */
export async function insertLedgerEntry(sql: SqlClient, ctx: EngineContext, order: OrderRow, entry: NewEntry): Promise<PaymentRow> {
  const id = ctx.newId();
  const res = await sql.query<PaymentRow>(
    `insert into payments
       (id, tenant_id, order_id, customer_id, kind, method, status, amount_paise, currency, provider, provider_reference, note, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning *`,
    [
      id,
      ctx.tenantId,
      order.id,
      order.customer_id,
      entry.kind,
      entry.method,
      PaymentEntryStatus.COMPLETED,
      entry.amountPaise,
      order.currency,
      entry.provider ?? null,
      entry.providerReference ?? null,
      entry.note ?? null,
      ctx.now(),
    ],
  );
  const row = res.rows[0] as PaymentRow;
  await emitEvent(sql, ctx, "payment.completed", {
    aggregateType: "payment",
    aggregateId: id,
    payload: {
      paymentId: id,
      orderId: order.id,
      reference: order.reference,
      kind: entry.kind,
      method: entry.method,
      amountPaise: entry.amountPaise,
      currency: order.currency,
      occurredAt: ctx.now().toISOString(),
    },
  });
  return row;
}

/**
 * Recompute payment_status from the ledger and store it. Does NOT bump the order version: a cashier recording a payment
 * must not invalidate the kitchen's view of the order. Returns the new status.
 */
export async function refreshPaymentStatus(sql: SqlClient, ctx: EngineContext, order: OrderRow): Promise<OrderRow> {
  const sums = await loadLedgerSums(sql, ctx, order.id);
  const status = derivePaymentStatus(toPaise(order.total_paise), sums);
  if (status === order.payment_status) return order;
  const res = await sql.query<OrderRow>(
    "update orders set payment_status = $3 where tenant_id = $1 and id = $2 returning *",
    [ctx.tenantId, order.id, status],
  );
  return res.rows[0] as OrderRow;
}

