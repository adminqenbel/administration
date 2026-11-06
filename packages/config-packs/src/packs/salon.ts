import { bookingTransitionsWithout, type ConfigPack } from "@qenbel/shared";
import { sameOn, weekHours } from "../helpers.ts";

export const salon: ConfigPack = {
  id: "salon",
  version: "1.0.0",
  label: "Salon",
  terminology: {
    resource: "Staff member",
    resources: "Staff",
    booking: "Appointment",
    bookings: "Appointments",
    order: "Order",
    orders: "Orders",
    customer: "Client",
    customers: "Clients",
    catalogueItem: "Service",
    catalogueItems: "Services",
  },
  bookingMode: "slot",
  orderMode: "none",
  resourceTypes: ["staff"],
  requiredCustomerFields: ["name", "phone"],
  bookingTransitions: {
    transitions: bookingTransitionsWithout(),
    labels: {
      HOLD: "On hold",
      CONFIRMED: "Booked",
      CHECKED_IN: "Arrived",
      COMPLETED: "Done",
      CANCELLED: "Cancelled",
      EXPIRED: "Expired",
      NO_SHOW: "No show",
    },
  },
  orderTransitions: { transitions: {}, labels: {} },
  notificationTemplates: {
    booking_confirmed: {
      title: "Appointment confirmed",
      body: "Hi {{customerName}}, your appointment for {{serviceName}} at {{businessName}} is confirmed for {{startsAt}}.",
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
  aiTools: [
    "get_business_profile",
    "search_customer",
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
      { id: "no_shows", label: "No shows" },
      { id: "new_customers", label: "New clients" },
    ],
  },
  defaults: {
    timezone: "Asia/Kolkata",
    hours: weekHours(sameOn(["mon", "tue", "wed", "thu", "fri", "sat"], { start: "10:00", end: "20:00" })),
    holdMinutes: 10,
    defaultDurationMinutes: 45,
    stepMinutes: 15,
    bufferMinutes: 0,
    cancellationPolicy: { cancelUntilHoursBefore: 4, lateCancellation: "flag" },
  },
};
