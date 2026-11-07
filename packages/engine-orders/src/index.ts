// @qenbel/engine-orders: draft, place, fulfil, cancel, refund and pay for orders. Plain functions:
//   (sql: SqlClient, ctx: EngineContext, input) => Promise<result>
// run inside `withTenant` from @qenbel/db. See README.md.
export {
  createOrderDraft,
  addItem,
  updateItem,
  removeItem,
  updateOrderNotes,
  applyDiscount,
  removeDiscount,
  setFulfilment,
  DISCOUNT_APPROVAL_CAP_BPS,
} from "./drafts.ts";
export {
  placeOrder,
  acceptOrder,
  startProcessing,
  markReady,
  fulfil,
  rejectOrder,
  cancelOrder,
  transitionOrder,
} from "./lifecycle.ts";
export { recordPayment, recordRefund, listPayments } from "./payments.ts";
export type { PaymentResult, PaymentList } from "./payments.ts";
export { getOrder, getOrderStatusForChannel, listOrders, getOrderBoard } from "./queries.ts";
export type { ChannelOrderStatus, OrderSummary, OrderPage, OrderBoardColumn } from "./queries.ts";
export type { PaymentEntryView } from "./ledger-db.ts";
export type { OrderView, OrderItemView, FulfilmentView, PaymentSummary } from "./view.ts";

export { computeTotals, discountAmount, allocateProportionally, discountBpsOfSubtotal, ORDER_ROUNDING_MODE, MAX_ORDER_TOTAL_PAISE } from "./totals.ts";
export type { DiscountSpec, Totals, TotalsLine, TotalsLineInput } from "./totals.ts";
export { derivePaymentStatus, netPaidPaise, outstandingPaise } from "./ledger.ts";
export type { LedgerSums } from "./ledger.ts";
export { machineForPack, setPackResolver } from "./pack.ts";
export type { PackResolver } from "./pack.ts";
export * from "./schemas.ts";
