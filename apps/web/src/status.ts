import type { ToneMap } from "@qenbel/ui";

// Status values follow docs/ARCHITECTURE.md section 5 (same strings as BookingStatus and OrderStatus
// in @qenbel/shared). test/status.test.ts checks these lists against packages/shared/src/enums.ts.

export const BOOKING_STATUSES = ["HOLD", "CONFIRMED", "CHECKED_IN", "COMPLETED", "CANCELLED", "EXPIRED", "NO_SHOW"] as const;
export const ORDER_STATUSES = ["DRAFT", "PLACED", "ACCEPTED", "PROCESSING", "READY", "FULFILLED", "CANCELLED", "REJECTED", "REFUNDED"] as const;

export const BOOKING_TONES: ToneMap = {
  HOLD: "warning",
  CONFIRMED: "info",
  CHECKED_IN: "info",
  COMPLETED: "success",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
  NO_SHOW: "danger",
};

export const ORDER_TONES: ToneMap = {
  DRAFT: "neutral",
  PLACED: "warning",
  ACCEPTED: "info",
  PROCESSING: "info",
  READY: "success",
  FULFILLED: "success",
  CANCELLED: "neutral",
  REJECTED: "danger",
  REFUNDED: "neutral",
};

const WORDS: Readonly<Record<string, string>> = {
  HOLD: "Hold",
  CONFIRMED: "Confirmed",
  CHECKED_IN: "Checked in",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  NO_SHOW: "No show",
  DRAFT: "Draft",
  PLACED: "Placed",
  ACCEPTED: "Accepted",
  PROCESSING: "Processing",
  READY: "Ready",
  FULFILLED: "Fulfilled",
  REJECTED: "Rejected",
  REFUNDED: "Refunded",
};

/** Plain words for a status, with a pack's relabels laid over them. */
export function statusLabels(statuses: ReadonlyArray<string>, overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of statuses) out[s] = overrides[s] ?? WORDS[s] ?? s;
  return out;
}
