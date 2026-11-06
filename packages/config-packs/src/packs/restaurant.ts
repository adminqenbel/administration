import { bookingTransitionsWithout, orderTransitionsWithout, type ConfigPack } from "@qenbel/shared";
import { sameOn, weekHours } from "../helpers.ts";

export const restaurant: ConfigPack = {
  id: "restaurant",
  version: "1.0.0",
  label: "Restaurant",
  terminology: {
    resource: "Table",
    resources: "Tables",
    booking: "Reservation",
    bookings: "Reservations",
    order: "Order",
    orders: "Orders",
    customer: "Guest",
    customers: "Guests",
    catalogueItem: "Menu item",
    catalogueItems: "Menu",
  },
  bookingMode: "table",
  orderMode: "dine_in",
  resourceTypes: ["table"],
  requiredCustomerFields: ["name", "phone"],
  bookingTransitions: {
    transitions: bookingTransitionsWithout(),
    labels: {
      HOLD: "Held",
      CONFIRMED: "Confirmed",
      CHECKED_IN: "Seated",
      COMPLETED: "Done",
      CANCELLED: "Cancelled",
      EXPIRED: "Expired",
      NO_SHOW: "No show",
    },
  },
  orderTransitions: {
    transitions: orderTransitionsWithout(),
    labels: {
      DRAFT: "Draft",
      PLACED: "New",
      ACCEPTED: "Accepted",
      PROCESSING: "Preparing",
      READY: "Ready",
      FULFILLED: "Served",
      CANCELLED: "Cancelled",
      REJECTED: "Declined",
      REFUNDED: "Refunded",
    },
  },
  notificationTemplates: {
    booking_confirmed: {
      title: "Reservation confirmed",
      body: "Hi {{customerName}}, your table at {{businessName}} is reserved for {{partySize}} on {{startsAt}}.",
    },
    booking_rescheduled: {
      title: "Reservation changed",
      body: "Hi {{customerName}}, your reservation at {{businessName}} is now {{startsAt}}.",
    },
    booking_cancelled: {
      title: "Reservation cancelled",
      body: "Hi {{customerName}}, your reservation at {{businessName}} on {{startsAt}} is cancelled.",
    },
    booking_reminder: {
      title: "Reservation reminder",
      body: "Hi {{customerName}}, a reminder of your reservation at {{businessName}} on {{startsAt}}.",
    },
    order_accepted: {
      title: "Order received",
      body: "Your order {{orderRef}} at {{businessName}} has been accepted.",
    },
    order_ready: {
      title: "Order ready",
      body: "Your order {{orderRef}} at {{businessName}} is ready.",
    },
    order_cancelled: {
      title: "Order cancelled",
      body: "Your order {{orderRef}} at {{businessName}} is cancelled.",
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
    "get_order_status",
    "create_order_draft",
    "confirm_order",
    "cancel_order",
    "escalate_to_human",
  ],
  dashboard: {
    widgets: [
      { id: "today_bookings", label: "Today" },
      { id: "kitchen_queue", label: "Kitchen" },
      { id: "open_orders", label: "Open orders" },
      { id: "pending_holds", label: "Held tables" },
      { id: "new_customers", label: "New guests" },
    ],
  },
  defaults: {
    timezone: "Asia/Kolkata",
    hours: weekHours(
      sameOn(["mon", "tue", "wed", "thu", "fri", "sat", "sun"], { start: "11:00", end: "15:30" }, { start: "18:30", end: "23:00" }),
    ),
    holdMinutes: 15,
    defaultDurationMinutes: 90,
    stepMinutes: 30,
    bufferMinutes: 0,
    cancellationPolicy: { cancelUntilHoursBefore: 2, lateCancellation: "flag" },
  },
};
