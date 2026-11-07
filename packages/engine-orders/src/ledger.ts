// Pure ledger arithmetic. The database rows are the source of truth; these functions only interpret sums.
import { PaymentStatus, type Paise } from "@qenbel/shared";

export interface LedgerSums {
  /** Sum of completed entries with kind = 'payment'. */
  paidPaise: Paise;
  /** Sum of completed entries with kind = 'refund'. */
  refundedPaise: Paise;
}

/** Money currently held against the order: payments minus refunds. Never negative in a consistent ledger. */
export function netPaidPaise(sums: LedgerSums): Paise {
  const net = sums.paidPaise - sums.refundedPaise;
  if (net < 0) throw new RangeError("ledger is inconsistent: refunds exceed payments");
  return net;
}

/** What the customer still owes. Zero when fully paid; never negative (overpayment is rejected on entry). */
export function outstandingPaise(totalPaise: Paise, sums: LedgerSums): Paise {
  return Math.max(totalPaise - netPaidPaise(sums), 0);
}

/**
 * payment_status follows the ledger:
 *   unpaid    nothing has been paid
 *   partial   some money is held, less than the total (includes a partial refund of a paid order)
 *   paid      money held covers the total
 *   refunded  money was paid and all of it has been refunded
 */
export function derivePaymentStatus(totalPaise: Paise, sums: LedgerSums): PaymentStatus {
  const net = netPaidPaise(sums);
  if (sums.paidPaise === 0) return PaymentStatus.UNPAID;
  if (net === 0) return PaymentStatus.REFUNDED;
  if (totalPaise > 0 && net >= totalPaise) return PaymentStatus.PAID;
  return PaymentStatus.PARTIAL;
}
