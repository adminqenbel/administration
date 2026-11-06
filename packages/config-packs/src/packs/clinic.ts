import { bookingTransitionsWithout, type ConfigPack } from "@qenbel/shared";
import { sameOn, weekHours } from "../helpers.ts";

export const clinic: ConfigPack = {
  id: "clinic",
  version: "1.0.0",
  label: "Clinic",
  terminology: {
    resource: "Doctor",
    resources: "Doctors",
    booking: "Appointment",
    bookings: "Appointments",
    order: "Order",
    orders: "Orders",
    customer: "Patient",
    customers: "Patients",
    catalogueItem: "Consultation",
    catalogueItems: "Consultations",
  },
  bookingMode: "slot",
  orderMode: "none",
  resourceTypes: ["doctor", "room"],
  // Date of birth is a customer field but optional: collect it, do not block a booking on it.
  requiredCustomerFields: ["name", "phone"],
  bookingTransitions: {
    transitions: bookingTransitionsWithout(),
    labels: {
      HOLD: "On hold",
      CONFIRMED: "Booked",
      CHECKED_IN: "Arrived",
      COMPLETED: "Seen",
      CANCELLED: "Cancelled",
      EXPIRED: "Expired",
      NO_SHOW: "Did not attend",
    },
  },
  orderTransitions: { transitions: {}, labels: {} },
  notificationTemplates: {
    booking_confirmed: {
      title: "Appointment confirmed",
      body: "Hi {{customerName}}, your appointment with {{resourceName}} at {{businessName}} is confirmed for {{startsAt}}.",
    },
    booking_rescheduled: {
      title: "Appointment changed",
      body: "Hi {{customerName}}, your appointment at {{businessName}} is now {{startsAt}}.",
    },
    booking_cancelled: {
      title: "Appointment cancelled",
      body: "Hi {{customerName}}, your appointment at {{businessName}} on {{startsAt}} is cancelled.",
    },
    booking_reminder: {
      title: "Appointment reminder",
      body: "Hi {{customerName}}, a reminder of your appointment at {{businessName}} on {{startsAt}}.",
    },
  },
  // No search_customer: patient records are not looked up through the AI channel.
  aiTools: [
    "get_business_profile",
    "get_catalogue",
    "check_availability",
    "create_booking_hold",
    "confirm_booking",
    "reschedule_booking",
    "cancel_booking",
    "escalate_to_human",
  ],
  dashboard: {
    widgets: [
      { id: "today_bookings", label: "Today" },
      { id: "upcoming_bookings", label: "Upcoming" },
      { id: "pending_holds", label: "On hold" },
      { id: "no_shows", label: "Did not attend" },
      { id: "resource_utilisation", label: "Doctors" },
    ],
  },
  defaults: {
    timezone: "Asia/Kolkata",
    hours: weekHours(
      sameOn(["mon", "tue", "wed", "thu", "fri", "sat"], { start: "09:00", end: "13:00" }, { start: "16:00", end: "20:00" }),
    ),
    holdMinutes: 10,
    defaultDurationMinutes: 20,
    stepMinutes: 10,
    bufferMinutes: 0,
    cancellationPolicy: { cancelUntilHoursBefore: 6, lateCancellation: "allow" },
  },
};
