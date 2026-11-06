// Minimal valid packs. Terminology and defaults are placeholders until each industry gets real content.
import { bookingTransitionsWithout, orderTransitionsWithout, type ConfigPack, type PackDefaults } from "@qenbel/shared";
import { sameOn, weekHours } from "../helpers.ts";

const none = { transitions: {}, labels: {} };

function defaults(overrides: Partial<PackDefaults> = {}): PackDefaults {
  return {
    timezone: "Asia/Kolkata",
    hours: weekHours(sameOn(["mon", "tue", "wed", "thu", "fri", "sat"], { start: "09:00", end: "18:00" })),
    holdMinutes: 10,
    defaultDurationMinutes: 60,
    stepMinutes: 30,
    bufferMinutes: 0,
    cancellationPolicy: { cancelUntilHoursBefore: 24, lateCancellation: "flag" },
    ...overrides,
  };
}

export const retail: ConfigPack = {
  id: "retail",
  version: "0.1.0",
  label: "Retail",
  terminology: {
    resource: "Counter",
    resources: "Counters",
    booking: "Booking",
    bookings: "Bookings",
    order: "Order",
    orders: "Orders",
    customer: "Customer",
    customers: "Customers",
    catalogueItem: "Product",
    catalogueItems: "Products",
  },
  bookingMode: "none",
  orderMode: "catalogue",
  resourceTypes: [],
  requiredCustomerFields: ["name", "phone"],
  bookingTransitions: none,
  orderTransitions: { transitions: orderTransitionsWithout(), labels: { PROCESSING: "Packing", FULFILLED: "Collected" } },
  notificationTemplates: {
    order_accepted: { title: "Order received", body: "Your order {{orderRef}} at {{businessName}} has been accepted." },
    order_ready: { title: "Order ready", body: "Your order {{orderRef}} at {{businessName}} is ready." },
  },
  aiTools: [
    "get_business_profile",
    "search_customer",
    "get_catalogue",
    "get_order_status",
    "create_order_draft",
    "confirm_order",
    "cancel_order",
    "escalate_to_human",
  ],
  dashboard: {
    widgets: [
      { id: "open_orders", label: "Open orders" },
      { id: "new_customers", label: "New customers" },
    ],
  },
  defaults: defaults({ hours: weekHours(sameOn(["mon", "tue", "wed", "thu", "fri", "sat", "sun"], { start: "10:00", end: "21:00" })) }),
};

export const hotel: ConfigPack = {
  id: "hotel",
  version: "0.1.0",
  label: "Hotel",
  terminology: {
    resource: "Room",
    resources: "Rooms",
    booking: "Stay",
    bookings: "Stays",
    order: "Order",
    orders: "Orders",
    customer: "Guest",
    customers: "Guests",
    catalogueItem: "Room type",
    catalogueItems: "Room types",
  },
  bookingMode: "room",
  orderMode: "none",
  resourceTypes: ["room"],
  requiredCustomerFields: ["name", "phone", "email"],
  bookingTransitions: { transitions: bookingTransitionsWithout(), labels: { CHECKED_IN: "Checked in", COMPLETED: "Checked out" } },
  orderTransitions: none,
  notificationTemplates: {
    booking_confirmed: {
      title: "Stay confirmed",
      body: "Hi {{customerName}}, your stay at {{businessName}} is confirmed from {{startsAt}}.",
    },
    booking_cancelled: {
      title: "Stay cancelled",
      body: "Hi {{customerName}}, your stay at {{businessName}} from {{startsAt}} is cancelled.",
    },
  },
  aiTools: [
    "get_business_profile",
    "get_catalogue",
    "check_availability",
    "create_booking_hold",
    "confirm_booking",
    "cancel_booking",
    "escalate_to_human",
  ],
  dashboard: {
    widgets: [
      { id: "today_bookings", label: "Arrivals today" },
      { id: "upcoming_bookings", label: "Upcoming" },
    ],
  },
  defaults: defaults({
    hours: weekHours(sameOn(["mon", "tue", "wed", "thu", "fri", "sat", "sun"], { start: "00:00", end: "24:00" })),
    defaultDurationMinutes: 1440,
    stepMinutes: 60,
    holdMinutes: 30,
  }),
};

export const homeServices: ConfigPack = {
  id: "home-services",
  version: "0.1.0",
  label: "Home services",
  terminology: {
    resource: "Technician",
    resources: "Technicians",
    booking: "Visit",
    bookings: "Visits",
    order: "Quote",
    orders: "Quotes",
    customer: "Customer",
    customers: "Customers",
    catalogueItem: "Service",
    catalogueItems: "Services",
  },
  bookingMode: "slot",
  orderMode: "quote",
  resourceTypes: ["staff"],
  requiredCustomerFields: ["name", "phone", "address"],
  bookingTransitions: { transitions: bookingTransitionsWithout(), labels: { CHECKED_IN: "On site" } },
  orderTransitions: { transitions: orderTransitionsWithout(), labels: { PLACED: "Requested", ACCEPTED: "Quoted" } },
  notificationTemplates: {
    booking_confirmed: {
      title: "Visit confirmed",
      body: "Hi {{customerName}}, a visit from {{businessName}} is confirmed for {{startsAt}}.",
    },
    booking_cancelled: {
      title: "Visit cancelled",
      body: "Hi {{customerName}}, the visit from {{businessName}} on {{startsAt}} is cancelled.",
    },
  },
  aiTools: [
    "get_business_profile",
    "get_catalogue",
    "check_availability",
    "create_booking_hold",
    "confirm_booking",
    "reschedule_booking",
    "cancel_booking",
    "get_order_status",
    "escalate_to_human",
  ],
  dashboard: {
    widgets: [
      { id: "today_bookings", label: "Today" },
      { id: "open_orders", label: "Open quotes" },
    ],
  },
  defaults: defaults(),
};

export const rental: ConfigPack = {
  id: "rental",
  version: "0.1.0",
  label: "Rental",
  terminology: {
    resource: "Item",
    resources: "Items",
    booking: "Rental period",
    bookings: "Rental periods",
    order: "Rental",
    orders: "Rentals",
    customer: "Customer",
    customers: "Customers",
    catalogueItem: "Item type",
    catalogueItems: "Item types",
  },
  bookingMode: "period",
  orderMode: "rental",
  resourceTypes: ["vehicle", "equipment"],
  requiredCustomerFields: ["name", "phone"],
  bookingTransitions: { transitions: bookingTransitionsWithout(), labels: { CHECKED_IN: "Picked up", COMPLETED: "Returned" } },
  orderTransitions: { transitions: orderTransitionsWithout(), labels: { PROCESSING: "Out", FULFILLED: "Returned" } },
  notificationTemplates: {
    booking_confirmed: {
      title: "Rental confirmed",
      body: "Hi {{customerName}}, your rental from {{businessName}} starts {{startsAt}}.",
    },
    booking_cancelled: {
      title: "Rental cancelled",
      body: "Hi {{customerName}}, your rental from {{businessName}} on {{startsAt}} is cancelled.",
    },
  },
  aiTools: [
    "get_business_profile",
    "get_catalogue",
    "check_availability",
    "create_booking_hold",
    "confirm_booking",
    "cancel_booking",
    "get_order_status",
    "escalate_to_human",
  ],
  dashboard: {
    widgets: [
      { id: "today_bookings", label: "Today" },
      { id: "open_orders", label: "Open rentals" },
      { id: "resource_utilisation", label: "Items" },
    ],
  },
  defaults: defaults({
    hours: weekHours(sameOn(["mon", "tue", "wed", "thu", "fri", "sat", "sun"], { start: "00:00", end: "24:00" })),
    defaultDurationMinutes: 1440,
    stepMinutes: 60,
  }),
};
