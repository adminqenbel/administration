// Words the interface uses. A config pack changes words and layout, never the brand tokens.
// Every nav label, page title and empty message is built from this object, so a clinic reads
// Doctors / Appointments / Patients and a restaurant reads Tables / Reservations / Kitchen.
//
// Pure TypeScript, no React, so it can be tested with node --test.

export interface Terminology {
  dashboard: string;
  bookings: string;
  booking: string;
  /** Nav label and page title for the orders screen (a restaurant shows "Kitchen"). */
  orders: string;
  /** The plain noun for a sentence: "No orders yet", even when the screen is called Kitchen. */
  ordersNoun: string;
  order: string;
  customers: string;
  customer: string;
  catalogue: string;
  catalogueItem: string;
  resources: string;
  resource: string;
  settings: string;
  /** A pack may relabel a status (for example PROCESSING shown as "Preparing"). It may not add statuses. */
  bookingStatusLabels: Readonly<Record<string, string>>;
  orderStatusLabels: Readonly<Record<string, string>>;
}

export const DEFAULT_TERMINOLOGY: Terminology = {
  dashboard: "Dashboard",
  bookings: "Bookings",
  booking: "Booking",
  orders: "Orders",
  ordersNoun: "Orders",
  order: "Order",
  customers: "Customers",
  customer: "Customer",
  catalogue: "Catalogue",
  catalogueItem: "Item",
  resources: "Resources",
  resource: "Resource",
  settings: "Settings",
  bookingStatusLabels: {},
  orderStatusLabels: {},
};

export type TerminologyOverrides = Partial<Terminology>;

/** Example maps. Real packs supply their own through the packs adapter (src/packs.ts). */
export const EXAMPLE_TERMINOLOGY: Readonly<Record<string, TerminologyOverrides>> = {
  salon: {
    bookings: "Appointments",
    booking: "Appointment",
    customers: "Clients",
    customer: "Client",
    catalogue: "Services",
    catalogueItem: "Service",
    resources: "Stylists",
    resource: "Stylist",
  },
  clinic: {
    bookings: "Appointments",
    booking: "Appointment",
    customers: "Patients",
    customer: "Patient",
    catalogue: "Services",
    catalogueItem: "Service",
    resources: "Doctors",
    resource: "Doctor",
  },
  restaurant: {
    bookings: "Reservations",
    booking: "Reservation",
    orders: "Kitchen",
    ordersNoun: "Orders",
    order: "Order",
    customers: "Guests",
    customer: "Guest",
    catalogue: "Menu",
    catalogueItem: "Dish",
    resources: "Tables",
    resource: "Table",
    bookingStatusLabels: { CHECKED_IN: "Seated" },
    orderStatusLabels: { PROCESSING: "Preparing", READY: "Ready to serve" },
  },
};

/** Default words with a pack's words laid over them. Unknown or missing pack gives the defaults. */
export function buildTerminology(overrides?: TerminologyOverrides | null): Terminology {
  return { ...DEFAULT_TERMINOLOGY, ...(overrides ?? {}) };
}

export function terminologyForPack(packId: string | null | undefined): Terminology {
  const overrides = packId ? EXAMPLE_TERMINOLOGY[packId] : undefined;
  return buildTerminology(overrides);
}

/** For mid-sentence use: "No appointments yet". */
export function lower(word: string): string {
  return word.toLocaleLowerCase("en");
}

/** Page copy built from the words. Short and plain; no promises, no prices. */
export function copy(t: Terminology) {
  return {
    emptyTitle: (plural: string) => `No ${lower(plural)} yet`,
    emptyText: (plural: string) => `${plural} will appear here once they are added.`,
    newBooking: `New ${lower(t.booking)}`,
    newOrder: `New ${lower(t.order)}`,
    newCustomer: `Add ${lower(t.customer)}`,
    newItem: `Add ${lower(t.catalogueItem)}`,
    newResource: `Add ${lower(t.resource)}`,
  };
}
