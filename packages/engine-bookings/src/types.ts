// Public result types. Field names match @qenbel/shared `Booking` and add the fields staff screens need.
import type { BookingStatus, Channel } from "@qenbel/shared";

export interface BookingView {
  id: string;
  /** Short human reference, unique per tenant. */
  reference: string;
  status: BookingStatus;
  /** Optimistic concurrency token. Send it back as expectedVersion. */
  version: number;
  /** First resource (the only one for most bookings). Null once nothing is allocated, for example before any hold. */
  resourceId: string | null;
  /** Every resource the booking occupies (or occupied, once released), in id order. */
  resourceIds: string[];
  customerId: string | null;
  catalogueItemId: string | null;
  locationId: string | null;
  /** ISO 8601 UTC. The service time only: the cleanup buffer is not included. */
  startsAt: string;
  endsAt: string;
  partySize: number | null;
  notes: string | null;
  holdExpiresAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  source: Channel;
  depositPaise: number;
  depositStatus: "unpaid" | "partial" | "paid" | "refunded";
  currency: string;
  /** Cancellation policy and deposit as they were when the booking was confirmed, plus the cancellation outcome. */
  policy: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WriteResult {
  booking: BookingView;
  /** True when the same Idempotency-Key and input had already been processed and nothing new was written. */
  replayed: boolean;
}

export type CancellationOutcomeKind = "free" | "late_allowed" | "late_flagged";

export interface CancellationOutcome {
  outcome: CancellationOutcomeKind;
  late: boolean;
  /** Hours from the cancellation to the start. Negative once the start has passed. */
  hoursBeforeStart: number;
  /** Fee due for a late cancellation, in paise. 0 when free. */
  feePaise: number;
  /** Part of a paid deposit to give back, in paise. */
  depositRefundPaise: number;
  /** The rule that was applied (from the snapshot taken at confirmation). */
  cancelUntilHoursBefore: number;
  lateCancellation: string;
}

export interface CancelResult extends WriteResult {
  cancellation: CancellationOutcome;
}

export interface BookingPage {
  items: BookingView[];
  nextCursor: string | null;
}

export interface BookingTimelineEntry {
  at: string;
  action: string;
  actorKind: string;
  actorId: string | null;
  channel: string | null;
  details: Record<string, unknown>;
}

export interface AvailabilitySlotView {
  startsAt: string;
  endsAt: string;
  resourceId: string;
  resourceName: string;
}

export interface AvailabilityResourceView {
  resourceId: string;
  resourceName: string;
  timezone: string;
  slots: { startsAt: string; endsAt: string }[];
}

export interface AvailabilityResult {
  /** IANA zone of the first resource (the tenant's default location zone when no resource matches). */
  timezone: string;
  /** All slots, sorted by start then resource name. */
  slots: AvailabilitySlotView[];
  /** The same slots grouped per resource, in name order. */
  resources: AvailabilityResourceView[];
}
