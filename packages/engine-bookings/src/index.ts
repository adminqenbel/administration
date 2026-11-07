// @qenbel/engine-bookings: availability, holds, confirmation, rescheduling, cancellation and the booking lifecycle.
// Plain functions `(sql, ctx, input, options?)`, run by the caller inside `withTenant`. See README.md.
export { checkAvailability } from "./availability.ts";
export { createHold } from "./holds.ts";
export { confirmBooking } from "./confirm.ts";
export { rescheduleBooking } from "./reschedule.ts";
export { cancelBooking } from "./cancel.ts";
export { checkIn, complete, markNoShow, transitionBooking } from "./lifecycle.ts";
export { getBooking, listBookings, listBookingEvents } from "./queries.ts";
export { expireHolds } from "./expiry.ts";
export type { ExpireHoldsResult } from "./expiry.ts";

export { machineForPack, loadConfig, bookingSettingsSchema } from "./config.ts";
export type { BookingConfig, BookingSettings, CancellationPolicy, EngineOptions } from "./config.ts";
export { createHoldInputSchema, listBookingsInputSchema } from "./schemas.ts";
export type { CreateHoldInput, ListBookingsInput } from "./schemas.ts";
export { sqlAvailabilityDataSource } from "./sql-source.ts";
export { slotsForResource, effectiveIntervals, peakUnits } from "./availability-core.ts";
export type {
  AllocationRow,
  AvailabilityDataSource,
  CandidateQuery,
  HolidayRow,
  HourRow,
  InputsWindow,
  ResourceAvailabilityInputs,
  ResourceCandidate,
  ResourceSummary,
  ScheduleRow,
} from "./availability-source.ts";
export { judgeCancellation, policyFor } from "./policy.ts";
export { BookingAuditAction } from "./events.ts";
export type {
  AvailabilityResourceView,
  AvailabilityResult,
  AvailabilitySlotView,
  BookingPage,
  BookingTimelineEntry,
  BookingView,
  CancelResult,
  CancellationOutcome,
  WriteResult,
} from "./types.ts";
