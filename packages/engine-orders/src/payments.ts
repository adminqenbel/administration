// Payments ledger. Rows are only ever inserted (the app role cannot update amounts or delete). Every entry locks the
// order row first (FOR UPDATE), so concurrent payments and refunds on one order are serialised and the overpayment
// and over-refund checks cannot race. No gateway: entries record what staff received or returned.
import { toPaise } from "@qenbel/db";
import { ErrorCode, OrderStatus, PaymentKind, type EngineContext, type SqlClient } from "@qenbel/shared";
import { assertTenantSession, audit, mapPgError, orderError, parseInput, withIdempotency } from "./common.ts";
import { insertLedgerEntry, paymentEntryView, refreshPaymentStatus, type PaymentEntryView, type PaymentRow } from "./ledger-db.ts";
import { netPaidPaise, outstandingPaise } from "./ledger.ts";
import { moveToRefundedIfFullyRefunded } from "./lifecycle.ts";
import { loadPackContext } from "./pack.ts";
import { requireStaff } from "./scope.ts";
import {
  listPaymentsInputSchema,
  recordPaymentInputSchema,
  recordRefundInputSchema,
  type ListPaymentsInput,
  type RecordPaymentInput,
  type RecordRefundInput,
} from "./schemas.ts";
import { buildOrderView, loadLedgerSums, loadOrderRow, paymentSummary, type OrderRow, type OrderView, type PaymentSummary } from "./view.ts";
import { invalidState, lockOrder } from "./write.ts";

export interface PaymentResult {
  payment: PaymentEntryView;
  order: OrderView;
}

export interface PaymentList {
  entries: PaymentEntryView[];
  summary: PaymentSummary;
}

/** Statuses in which money can be taken: the totals are frozen and the order is live. */
const PAYABLE: readonly OrderStatus[] = [
  OrderStatus.PLACED,
  OrderStatus.ACCEPTED,
  OrderStatus.PROCESSING,
  OrderStatus.READY,
  OrderStatus.FULFILLED,
];

async function loadResult(sql: SqlClient, ctx: EngineContext, paymentId: string): Promise<PaymentResult> {
  const res = await sql.query<PaymentRow>("select * from payments where tenant_id = $1 and id = $2", [ctx.tenantId, paymentId]);
  const row = res.rows[0] as PaymentRow;
  const order = await loadOrderRow(sql, ctx, row.order_id, false);
  const packCtx = await loadPackContext(sql, ctx, false);
  return { payment: paymentEntryView(row), order: await buildOrderView(sql, ctx, packCtx, order) };
}

/**
 * Record money received for an order (cash, card machine, UPI transfer ...). Rejected: draft, cancelled, rejected or
 * refunded orders; an amount above the outstanding balance (OVERPAYMENT). Updates payment_status from the ledger and
 * queues `payment.completed`. Idempotent on ctx.idempotencyKey. Does not bump the order version.
 */
export async function recordPayment(sql: SqlClient, ctx: EngineContext, rawInput: RecordPaymentInput): Promise<PaymentResult> {
  const input = parseInput(recordPaymentInputSchema, rawInput);
  requireStaff(ctx, "recordPayment");
  await assertTenantSession(sql, ctx);
  try {
    return await withIdempotency(
      sql,
      ctx,
      "engine:orders:recordPayment",
      input,
      async () => {
        const order = await lockOrder(sql, ctx, input.orderId, undefined);
        if (!PAYABLE.includes(order.status)) throw invalidState(order, "payments can only be recorded on a placed order");
        const sums = await loadLedgerSums(sql, ctx, order.id);
        const outstanding = outstandingPaise(toPaise(order.total_paise), sums);
        if (input.amountPaise > outstanding) {
          throw orderError(ErrorCode.CONFLICT, "OVERPAYMENT", "That is more than the outstanding balance.", { outstandingPaise: outstanding });
        }
        const entry = await insertLedgerEntry(sql, ctx, order, {
          kind: PaymentKind.PAYMENT,
          method: input.method,
          amountPaise: input.amountPaise,
          note: input.note,
          provider: input.provider,
          providerReference: input.providerReference,
        });
        await refreshPaymentStatus(sql, ctx, order);
        await audit(sql, ctx, "order.payment_recorded", "order", order.id, {
          paymentId: entry.id,
          method: input.method,
          amountPaise: input.amountPaise,
        });
        return entry.id;
      },
      (paymentId) => loadResult(sql, ctx, paymentId),
    );
  } catch (err) {
    return mapPgError(err);
  }
}

/**
 * Record money returned. Rejected: a draft order, an amount above what the order holds (payments minus refunds).
 * When a FULFILLED order becomes fully refunded and the pack allows FULFILLED -> REFUNDED, the order moves to REFUNDED
 * (version +1). Idempotent on ctx.idempotencyKey. Queues `payment.refunded`.
 */
export async function recordRefund(sql: SqlClient, ctx: EngineContext, rawInput: RecordRefundInput): Promise<PaymentResult> {
  const input = parseInput(recordRefundInputSchema, rawInput);
  requireStaff(ctx, "recordRefund");
  await assertTenantSession(sql, ctx);
  const packCtx = await loadPackContext(sql, ctx, false);
  try {
    return await withIdempotency(
      sql,
      ctx,
      "engine:orders:recordRefund",
      input,
      async () => {
        const order = await lockOrder(sql, ctx, input.orderId, undefined);
        if (order.status === OrderStatus.DRAFT) throw invalidState(order, "a draft has no payments to refund");
        const sums = await loadLedgerSums(sql, ctx, order.id);
        const held = netPaidPaise(sums);
        if (input.amountPaise > held) {
          throw orderError(ErrorCode.CONFLICT, "REFUND_EXCEEDS_PAID", "That is more than was paid.", { refundablePaise: held });
        }
        const entry = await insertLedgerEntry(sql, ctx, order, {
          kind: PaymentKind.REFUND,
          method: input.method,
          amountPaise: input.amountPaise,
          note: input.note,
        });
        let current: OrderRow = await refreshPaymentStatus(sql, ctx, order);
        const moved = await moveToRefundedIfFullyRefunded(sql, ctx, packCtx, current);
        if (moved) current = moved;
        await audit(sql, ctx, "order.refund_recorded", "order", order.id, {
          paymentId: entry.id,
          method: input.method,
          amountPaise: input.amountPaise,
          orderStatus: current.status,
        });
        return entry.id;
      },
      (paymentId) => loadResult(sql, ctx, paymentId),
    );
  } catch (err) {
    return mapPgError(err);
  }
}

/** Ledger entries for one order, oldest first, with the balance summary. */
export async function listPayments(sql: SqlClient, ctx: EngineContext, rawInput: ListPaymentsInput): Promise<PaymentList> {
  const input = parseInput(listPaymentsInputSchema, rawInput);
  requireStaff(ctx, "listPayments");
  await assertTenantSession(sql, ctx);
  const order = await loadOrderRow(sql, ctx, input.orderId, false);
  const res = await sql.query<PaymentRow>(
    "select * from payments where tenant_id = $1 and order_id = $2 order by occurred_at, created_at, id limit 500",
    [ctx.tenantId, order.id],
  );
  const sums = await loadLedgerSums(sql, ctx, order.id);
  return { entries: res.rows.map(paymentEntryView), summary: paymentSummary(toPaise(order.total_paise), sums) };
}
