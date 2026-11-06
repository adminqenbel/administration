import { z } from "zod";
import { BookingStatus, Channel, OrderStatus, PaymentStatus, ToolName, ToolPermissionLevel } from "@qenbel/shared";
import { defineTool } from "./define.ts";
import { ToolErrorCode as E } from "./errors.ts";
import { answers, currency, customerDetails, email, idOf, isoDate, isoDateTime, paise, phone, smallInt, text } from "./primitives.ts";

const { READ, WRITE, CONTROLLED_WRITE } = ToolPermissionLevel;
const { WEB_CHAT, WHATSAPP, VOICE, API } = Channel;

// Channels. Public web chat and voice cannot prove who is speaking, so they get no tool that
// reads or changes an existing record for a named person. WhatsApp and API callers can; the
// server still limits every call to records linked to the conversation's verified contact.
const ALL_CHANNELS = [WEB_CHAT, WHATSAPP, VOICE, API] as const;
const VERIFIED_CONTACT_CHANNELS = [WHATSAPP, API] as const;

// Illustrative ids for examples. Fake, never real.
const ID = {
  service: "3f9c2a1e-5b7d-4c8a-9e21-7a6b5c4d3e2f",
  service2: "6b1d8e34-2a9f-4e07-8c55-1f0a9b8c7d6e",
  staff: "a2c4e6f8-1b3d-4f5a-9b7c-0d1e2f3a4b5c",
  location: "c0ffee00-1111-4222-8333-444455556666",
  booking: "b00c1d2e-3f40-4a51-8b62-73849a5b6c7d",
  customer: "d1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6",
  order: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
  item1: "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b",
  item2: "f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b9c",
  task: "99887766-5544-4332-a211-009988776655",
} as const;

const bookingStatus = z.enum(BookingStatus);
const orderStatus = z.enum(OrderStatus);
const paymentStatus = z.enum(PaymentStatus);

const bookingSummary = z.object({
  bookingId: z.uuid().describe("Id of the booking."),
  reference: z.string().max(32).describe("Short reference the customer can quote."),
  status: bookingStatus,
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  timezone: z.string().max(64).describe("IANA time zone of the location, e.g. Asia/Kolkata."),
  serviceName: z.string().max(200).optional(),
  resourceName: z.string().max(200).optional().describe("Staff member, doctor, room or table."),
  partySize: z.int().min(1).optional(),
  version: z.int().min(1).describe("Changes every time the booking changes."),
});

const orderLine = z.object({
  catalogueItemId: z.uuid(),
  name: z.string().max(200),
  quantity: z.int().min(1),
  unitAmountPaise: paise("Price of one"),
  lineAmountPaise: paise("Price of the line"),
  notes: z.string().max(300).optional(),
});

const orderSummary = z.object({
  orderId: z.uuid(),
  reference: z.string().max(32).describe("Short reference the customer can quote."),
  status: orderStatus,
  statusLabel: z.string().max(60).optional().describe("The word this business uses for the status, e.g. Preparing."),
  paymentStatus: paymentStatus,
  lines: z.array(orderLine).max(50),
  totalAmountPaise: paise("Order total"),
  currency,
  version: z.int().min(1),
});

// 1. get_business_profile -----------------------------------------------------------------------

export const getBusinessProfile = defineTool({
  name: ToolName.GET_BUSINESS_PROFILE,
  title: "Get business profile",
  description:
    "Returns the business's name, locations, opening hours, contact details, cancellation policy, how it takes bookings and orders, and which details a customer must give to book or order. " +
    "Call it first in a conversation and whenever the customer asks about hours, address or policy. " +
    "Does not return prices, staff lists, availability, customer records or anything about a particular booking or order.",
  permissionLevel: READ,
  requiredPermission: "business:read",
  input: z.strictObject({}),
  output: z.object({
    businessName: z.string().max(200),
    packId: z.string().max(60).describe("Kind of business, e.g. salon, clinic or restaurant."),
    bookingMode: z.string().max(20).describe("How bookings work: slot, table, room, period or none."),
    orderMode: z.string().max(20).describe("How orders work: catalogue, dine_in, quote, rental or none."),
    timezone: z.string().max(64),
    currency,
    locations: z
      .array(
        z.object({
          locationId: z.uuid(),
          name: z.string().max(200),
          address: z.string().max(400).optional(),
          timezone: z.string().max(64),
        }),
      )
      .max(50),
    hours: z
      .array(
        z.object({
          dayOfWeek: z.int().min(0).max(6).describe("0 is Sunday."),
          opens: z.string().max(5).describe("HH:MM, 24-hour, local time."),
          closes: z.string().max(5),
        }),
      )
      .max(21),
    contact: z.object({ phone: z.string().max(32).optional(), email: z.string().max(254).optional() }),
    cancellationPolicy: z.object({
      summary: z.string().max(500),
      freeCancelHoursBefore: z.int().min(0).nullable(),
    }),
    requiredCustomerFields: z.array(z.string().max(60)).max(20).describe("Details to ask for before confirming: name, phone, email and so on."),
    extraQuestions: z
      .array(z.object({ field: z.string().max(60), label: z.string().max(200), required: z.boolean() }))
      .max(20)
      .describe("Extra questions this business asks. Answer them with the `answers` field when confirming."),
  }),
  examples: [
    {
      title: "Salon",
      input: {},
      output: {
        businessName: "Test Salon",
        packId: "salon",
        bookingMode: "slot",
        orderMode: "none",
        timezone: "Asia/Kolkata",
        currency: "INR",
        locations: [{ locationId: ID.location, name: "Main", address: "12 Example Road, Sample City", timezone: "Asia/Kolkata" }],
        hours: [
          { dayOfWeek: 1, opens: "10:00", closes: "20:00" },
          { dayOfWeek: 2, opens: "10:00", closes: "20:00" },
        ],
        contact: { phone: "+919800000000" },
        cancellationPolicy: { summary: "Free to cancel up to 4 hours before.", freeCancelHoursBefore: 4 },
        requiredCustomerFields: ["name", "phone"],
        extraQuestions: [],
      },
    },
  ],
  errorCodes: [],
  defaultChannels: ALL_CHANNELS,
});

// 2. search_customer ----------------------------------------------------------------------------

export const searchCustomer = defineTool({
  name: ToolName.SEARCH_CUSTOMER,
  title: "Search customer",
  description:
    "Finds an existing customer by phone number, email or name and returns only their id, first name and masked contact details. " +
    "Use it to link a booking or order to a returning customer. Give at least one of phone, email or name; phone or email are exact matches, name is a partial match. " +
    "On WhatsApp and API calls the server limits results to the contact in the conversation. " +
    "Does not create or change customers, does not return full phone numbers, email addresses, notes, visit history or payment details, and cannot list all customers.",
  permissionLevel: READ,
  requiredPermission: "customers:read",
  input: z.strictObject({
    phone: phone.optional(),
    email: email.optional(),
    name: text(2, 120, "Full or partial name.").optional(),
    limit: smallInt(1, 5, "Most results to return.").default(3),
  }),
  output: z.object({
    customers: z
      .array(
        z.object({
          customerId: z.uuid(),
          displayName: z.string().max(120),
          phoneMasked: z.string().max(20).optional().describe("Last digits only, e.g. ******3210."),
          emailMasked: z.string().max(254).optional(),
          hasUpcomingBooking: z.boolean(),
        }),
      )
      .max(5),
  }),
  examples: [
    {
      title: "By phone",
      input: { phone: "+919876543210" },
      output: { customers: [{ customerId: ID.customer, displayName: "Asha K", phoneMasked: "******3210", hasUpcomingBooking: false }] },
    },
  ],
  errorCodes: [E.CONTACT_MISMATCH],
  defaultChannels: VERIFIED_CONTACT_CHANNELS,
});

// 3. get_catalogue ------------------------------------------------------------------------------

export const getCatalogue = defineTool({
  name: ToolName.GET_CATALOGUE,
  title: "Get catalogue",
  description:
    "Lists what the business offers (services, products or menu items) with name, short description, price in paise, duration and whether it can be booked or ordered now. " +
    "Use it to answer what is offered and to find the item id needed by check_availability and create_order_draft. Filter by a search word or category. Results are paged. " +
    "Does not check availability or stock for a date, does not apply discounts, and never returns items the business has hidden or archived.",
  permissionLevel: READ,
  requiredPermission: "catalogue:read",
  input: z.strictObject({
    query: text(1, 100, "Search word, matched against name and description.").optional(),
    category: text(1, 60, "Exact category name.").optional(),
    kind: z.enum(["service", "product", "menu_item"]).optional().describe("Limit to one kind of item."),
    limit: smallInt(1, 50, "Items per page.").default(25),
    cursor: text(1, 200, "The `nextCursor` from the previous page.").optional(),
  }),
  output: z.object({
    items: z
      .array(
        z.object({
          catalogueItemId: z.uuid(),
          name: z.string().max(200),
          kind: z.enum(["service", "product", "menu_item"]),
          description: z.string().max(1000).optional(),
          category: z.string().max(60).optional(),
          amountPaise: paise("Price"),
          currency,
          durationMinutes: z.int().min(1).optional(),
          available: z.boolean(),
        }),
      )
      .max(50),
    nextCursor: z.string().max(200).nullable(),
  }),
  examples: [
    {
      title: "Salon services",
      input: { kind: "service", limit: 2 },
      output: {
        items: [
          { catalogueItemId: ID.service, name: "Haircut", kind: "service", category: "Hair", amountPaise: 50000, currency: "INR", durationMinutes: 45, available: true },
          { catalogueItemId: ID.service2, name: "Hair colour", kind: "service", category: "Hair", amountPaise: 250000, currency: "INR", durationMinutes: 120, available: true },
        ],
        nextCursor: null,
      },
    },
  ],
  errorCodes: [],
  defaultChannels: ALL_CHANNELS,
});

// 4. check_availability -------------------------------------------------------------------------

export const checkAvailability = defineTool({
  name: ToolName.CHECK_AVAILABILITY,
  title: "Check availability",
  description:
    "Returns free times for one service (or a table for a party size) between two dates, in the business's local time. " +
    "Always call it before offering a time; never guess times. Pass the service id from get_catalogue when the business books by service, and partySize when it books tables. You may name a preferred staff member or location. " +
    "Does not reserve anything: a time can be taken by someone else before you hold it, so follow with create_booking_hold. It does not return prices and does not look further than 14 days from the start date.",
  permissionLevel: READ,
  requiredPermission: "bookings:read",
  input: z.strictObject({
    catalogueItemId: idOf("service").optional(),
    fromDate: isoDate("First day to search"),
    toDate: isoDate("Last day to search, included. Defaults to fromDate. At most 14 days after fromDate").optional(),
    partySize: smallInt(1, 50, "Number of people. Needed when the business books tables or rooms.").optional(),
    resourceId: idOf("preferred staff member, doctor, room or table").optional(),
    locationId: idOf("location").optional(),
    limit: smallInt(1, 20, "Most times to return.").default(10),
  }),
  output: z.object({
    timezone: z.string().max(64),
    slots: z
      .array(
        z.object({
          startsAt: z.iso.datetime({ offset: true }),
          endsAt: z.iso.datetime({ offset: true }),
          locationId: z.uuid(),
          resourceId: z.uuid().optional(),
          resourceName: z.string().max(200).optional(),
        }),
      )
      .max(20),
    hasMore: z.boolean().describe("True if more times exist than were returned. Narrow the dates to see them."),
  }),
  examples: [
    {
      title: "Salon haircut on a weekday",
      input: { catalogueItemId: ID.service, fromDate: "2026-12-01", limit: 2 },
      output: {
        timezone: "Asia/Kolkata",
        slots: [
          { startsAt: "2026-12-01T10:30:00+05:30", endsAt: "2026-12-01T11:15:00+05:30", locationId: ID.location, resourceId: ID.staff, resourceName: "Meera" },
          { startsAt: "2026-12-01T11:15:00+05:30", endsAt: "2026-12-01T12:00:00+05:30", locationId: ID.location, resourceId: ID.staff, resourceName: "Meera" },
        ],
        hasMore: true,
      },
    },
    {
      title: "Restaurant table for four",
      input: { fromDate: "2026-12-05", partySize: 4, limit: 1 },
      output: {
        timezone: "Asia/Kolkata",
        slots: [{ startsAt: "2026-12-05T20:00:00+05:30", endsAt: "2026-12-05T21:30:00+05:30", locationId: ID.location, resourceName: "Table 6" }],
        hasMore: true,
      },
    },
  ],
  errorCodes: [E.CATALOGUE_ITEM_NOT_FOUND, E.RESOURCE_NOT_FOUND, E.LOCATION_NOT_FOUND, E.BOOKING_MODE_NOT_SUPPORTED, E.BOOKING_OUTSIDE_WINDOW],
  defaultChannels: ALL_CHANNELS,
});

// 5. create_booking_hold ------------------------------------------------------------------------

export const createBookingHold = defineTool({
  name: ToolName.CREATE_BOOKING_HOLD,
  title: "Hold a booking time",
  description:
    "Holds one time from check_availability for a short while so nobody else can take it, and returns a booking in HOLD status with an expiry. " +
    "Use it once the customer has picked a time, then collect their details and call confirm_booking before the hold expires. Pass the same start time and resource that check_availability returned. " +
    "Does not confirm the booking and does not tell the customer it is booked. A hold that is not confirmed in time is released on its own. It does not take payment.",
  permissionLevel: WRITE,
  requiredPermission: "bookings:write",
  input: z.strictObject({
    catalogueItemId: idOf("service").optional(),
    startsAt: isoDateTime("Start time, exactly as returned by check_availability"),
    resourceId: idOf("staff member, doctor, room or table, as returned by check_availability").optional(),
    locationId: idOf("location").optional(),
    partySize: smallInt(1, 50, "Number of people. Needed when the business books tables or rooms.").optional(),
    customerId: idOf("customer, from search_customer").optional(),
  }),
  output: bookingSummary.extend({
    status: z.literal(BookingStatus.HOLD),
    expiresAt: z.iso.datetime({ offset: true }).describe("The hold is released at this time if the booking is not confirmed."),
  }),
  examples: [
    {
      title: "Clinic consultation",
      input: { catalogueItemId: ID.service2, startsAt: "2026-12-02T16:00:00+05:30", resourceId: ID.staff },
      output: {
        bookingId: ID.booking,
        reference: "QB-4F7K2",
        status: "HOLD",
        startsAt: "2026-12-02T16:00:00+05:30",
        endsAt: "2026-12-02T16:20:00+05:30",
        timezone: "Asia/Kolkata",
        serviceName: "Consultation",
        resourceName: "Dr Rao",
        version: 1,
        expiresAt: "2026-12-01T09:25:00+05:30",
      },
    },
  ],
  errorCodes: [E.CATALOGUE_ITEM_NOT_FOUND, E.RESOURCE_NOT_FOUND, E.LOCATION_NOT_FOUND, E.BOOKING_MODE_NOT_SUPPORTED, E.BOOKING_SLOT_TAKEN, E.BOOKING_OUTSIDE_HOURS, E.BOOKING_OUTSIDE_WINDOW],
  defaultChannels: ALL_CHANNELS,
});

// 6. confirm_booking ----------------------------------------------------------------------------

export const confirmBooking = defineTool({
  name: ToolName.CONFIRM_BOOKING,
  title: "Confirm a booking",
  description:
    "Turns a live hold into a confirmed booking once you have the customer's details. Pass the booking id from create_booking_hold, the customer's name and contact details, and answers to any extra questions listed in the business profile. " +
    "Only say the booking is confirmed after this call succeeds. " +
    "Does not work on a hold that has expired or on a booking that is already confirmed, cancelled or completed, does not change the time (use reschedule_booking), and does not take payment.",
  permissionLevel: CONTROLLED_WRITE,
  requiredPermission: "bookings:write",
  input: z.strictObject({
    bookingId: idOf("booking hold"),
    customer: customerDetails,
    answers: answers.optional(),
    notes: text(0, 500, "Anything the customer asked the business to know.").optional(),
  }),
  output: bookingSummary.extend({ status: z.literal(BookingStatus.CONFIRMED) }),
  examples: [
    {
      title: "Salon haircut",
      input: { bookingId: ID.booking, customer: { name: "Asha K", phone: "+919876543210" } },
      output: {
        bookingId: ID.booking,
        reference: "QB-4F7K2",
        status: "CONFIRMED",
        startsAt: "2026-12-01T10:30:00+05:30",
        endsAt: "2026-12-01T11:15:00+05:30",
        timezone: "Asia/Kolkata",
        serviceName: "Haircut",
        resourceName: "Meera",
        version: 2,
      },
    },
  ],
  errorCodes: [E.BOOKING_NOT_FOUND, E.BOOKING_HOLD_EXPIRED, E.BOOKING_INVALID_STATE, E.BOOKING_REQUIRED_FIELDS_MISSING, E.CONTACT_MISMATCH],
  defaultChannels: ALL_CHANNELS,
});

// 7. reschedule_booking -------------------------------------------------------------------------

export const rescheduleBooking = defineTool({
  name: ToolName.RESCHEDULE_BOOKING,
  title: "Reschedule a booking",
  description:
    "Moves a confirmed booking to a new time taken from check_availability. The old time is released only if the new one is free. " +
    "Use it when the customer asks to change the time of an existing booking. Pass expectedVersion from the last read of the booking if you have it. " +
    "Does not change the service, the customer or the party size, does not work on cancelled, completed or no-show bookings, and does not create a new booking.",
  permissionLevel: CONTROLLED_WRITE,
  requiredPermission: "bookings:write",
  input: z.strictObject({
    bookingId: idOf("booking"),
    newStartsAt: isoDateTime("New start time, exactly as returned by check_availability"),
    resourceId: idOf("staff member, doctor, room or table for the new time").optional(),
    expectedVersion: smallInt(1, 100000, "Version of the booking you last saw.").optional(),
    reason: text(0, 300, "Why the customer wants to move it.").optional(),
  }),
  output: bookingSummary.extend({
    status: z.literal(BookingStatus.CONFIRMED),
    previousStartsAt: z.iso.datetime({ offset: true }),
  }),
  examples: [
    {
      title: "Move to the next day",
      input: { bookingId: ID.booking, newStartsAt: "2026-12-02T11:00:00+05:30" },
      output: {
        bookingId: ID.booking,
        reference: "QB-4F7K2",
        status: "CONFIRMED",
        startsAt: "2026-12-02T11:00:00+05:30",
        endsAt: "2026-12-02T11:45:00+05:30",
        timezone: "Asia/Kolkata",
        serviceName: "Haircut",
        resourceName: "Meera",
        version: 3,
        previousStartsAt: "2026-12-01T10:30:00+05:30",
      },
    },
  ],
  errorCodes: [E.BOOKING_NOT_FOUND, E.BOOKING_INVALID_STATE, E.BOOKING_VERSION_CONFLICT, E.BOOKING_SLOT_TAKEN, E.BOOKING_OUTSIDE_HOURS, E.BOOKING_OUTSIDE_WINDOW, E.RESOURCE_NOT_FOUND, E.CONTACT_MISMATCH],
  defaultChannels: VERIFIED_CONTACT_CHANNELS,
});

// 8. cancel_booking -----------------------------------------------------------------------------

export const cancelBooking = defineTool({
  name: ToolName.CANCEL_BOOKING,
  title: "Cancel a booking",
  description:
    "Cancels a booking and applies the business's cancellation policy. The result says whether the cancellation was inside the free window and whether a fee applies, so you can tell the customer plainly. " +
    "Use it only when the customer clearly asks to cancel. Ask them to confirm first. " +
    "Does not refund money, does not rebook, does not work on bookings that are already cancelled, completed or marked no-show, and cannot override the policy: if the business does not allow online cancellation it returns an error, so offer escalate_to_human.",
  permissionLevel: CONTROLLED_WRITE,
  requiredPermission: "bookings:write",
  input: z.strictObject({
    bookingId: idOf("booking"),
    reason: text(0, 300, "Why the customer is cancelling.").optional(),
  }),
  output: z.object({
    bookingId: z.uuid(),
    reference: z.string().max(32),
    status: z.literal(BookingStatus.CANCELLED),
    cancelledAt: z.iso.datetime({ offset: true }),
    policy: z.object({
      withinFreeWindow: z.boolean(),
      feeApplies: z.boolean(),
      feeAmountPaise: paise("Cancellation fee").nullable(),
      summary: z.string().max(500),
    }),
    version: z.int().min(1),
  }),
  examples: [
    {
      title: "Cancelled inside the free window",
      input: { bookingId: ID.booking, reason: "Change of plan" },
      output: {
        bookingId: ID.booking,
        reference: "QB-4F7K2",
        status: "CANCELLED",
        cancelledAt: "2026-11-30T09:00:00+05:30",
        policy: { withinFreeWindow: true, feeApplies: false, feeAmountPaise: null, summary: "Free to cancel up to 4 hours before." },
        version: 3,
      },
    },
  ],
  errorCodes: [E.BOOKING_NOT_FOUND, E.BOOKING_INVALID_STATE, E.BOOKING_CANCEL_NOT_ALLOWED, E.CONTACT_MISMATCH],
  defaultChannels: VERIFIED_CONTACT_CHANNELS,
});

// 9. get_order_status ---------------------------------------------------------------------------

export const getOrderStatus = defineTool({
  name: ToolName.GET_ORDER_STATUS,
  title: "Get order status",
  description:
    "Returns the current status, items and total of one order, found by its id or by the short reference the customer was given. " +
    "Use it when the customer asks where their order is. Give orderId or orderReference. " +
    "Does not list a customer's orders, does not change anything, and does not give delivery or ready times: say only what the status shows.",
  permissionLevel: READ,
  requiredPermission: "orders:read",
  input: z.strictObject({
    orderId: idOf("order").optional(),
    orderReference: text(3, 32, "Short reference the customer was given.").optional(),
  }),
  output: orderSummary.extend({ updatedAt: z.iso.datetime({ offset: true }) }),
  examples: [
    {
      title: "Restaurant order being prepared",
      input: { orderReference: "QO-81M3" },
      output: {
        orderId: ID.order,
        reference: "QO-81M3",
        status: "PROCESSING",
        statusLabel: "Preparing",
        paymentStatus: "unpaid",
        lines: [{ catalogueItemId: ID.item1, name: "Paneer tikka", quantity: 2, unitAmountPaise: 28000, lineAmountPaise: 56000 }],
        totalAmountPaise: 56000,
        currency: "INR",
        version: 3,
        updatedAt: "2026-12-01T20:10:00+05:30",
      },
    },
  ],
  errorCodes: [E.ORDER_NOT_FOUND, E.CONTACT_MISMATCH],
  defaultChannels: VERIFIED_CONTACT_CHANNELS,
});

// 10. create_order_draft ------------------------------------------------------------------------

export const createOrderDraft = defineTool({
  name: ToolName.CREATE_ORDER_DRAFT,
  title: "Start an order",
  description:
    "Creates an order in DRAFT status from catalogue items and quantities, and returns the priced lines and total so the customer can check them. " +
    "Use it once the customer has said what they want. Read the lines and total back to them, then call confirm_order if they agree. Use item ids from get_catalogue. " +
    "Does not place the order, does not take payment, does not accept discounts or prices from the customer, and does not reserve stock. If an item is not available it returns an error that names it.",
  permissionLevel: WRITE,
  requiredPermission: "orders:write",
  input: z.strictObject({
    items: z
      .array(
        z.strictObject({
          catalogueItemId: idOf("catalogue item"),
          quantity: smallInt(1, 99, "How many."),
          notes: text(0, 300, "Item note, e.g. no onions.").optional(),
        }),
      )
      .min(1)
      .max(50),
    fulfilmentType: z.enum(["pickup", "dine_in", "delivery"]).optional().describe("How the customer gets it, if the business offers a choice."),
    tableLabel: text(1, 20, "Table name or number for dine-in orders.").optional(),
    customerId: idOf("customer, from search_customer").optional(),
    notes: text(0, 500, "Note for the whole order.").optional(),
  }),
  output: orderSummary.extend({ status: z.literal(OrderStatus.DRAFT) }),
  examples: [
    {
      title: "Restaurant dine-in",
      input: { items: [{ catalogueItemId: ID.item1, quantity: 2 }], fulfilmentType: "dine_in", tableLabel: "6" },
      output: {
        orderId: ID.order,
        reference: "QO-81M3",
        status: "DRAFT",
        paymentStatus: "unpaid",
        lines: [{ catalogueItemId: ID.item1, name: "Paneer tikka", quantity: 2, unitAmountPaise: 28000, lineAmountPaise: 56000 }],
        totalAmountPaise: 56000,
        currency: "INR",
        version: 1,
      },
    },
  ],
  errorCodes: [E.CATALOGUE_ITEM_NOT_FOUND, E.ORDER_ITEM_UNAVAILABLE, E.ORDER_MODE_NOT_SUPPORTED],
  defaultChannels: ALL_CHANNELS,
});

// 11. confirm_order -----------------------------------------------------------------------------

export const confirmOrder = defineTool({
  name: ToolName.CONFIRM_ORDER,
  title: "Place an order",
  description:
    "Places a draft order (DRAFT to PLACED) once the customer has agreed to the lines and total and you have their details. Pass the order id from create_order_draft and the customer's name and contact details. " +
    "Only say the order is placed after this call succeeds. " +
    "Does not take payment, does not change items or quantities (make a new draft for that), does not work on orders that are already placed, cancelled or fulfilled, and does not promise a ready or delivery time.",
  permissionLevel: CONTROLLED_WRITE,
  requiredPermission: "orders:write",
  input: z.strictObject({
    orderId: idOf("draft order"),
    customer: customerDetails,
    answers: answers.optional(),
    expectedVersion: smallInt(1, 100000, "Version of the order you last saw.").optional(),
  }),
  output: orderSummary.extend({ status: z.literal(OrderStatus.PLACED) }),
  examples: [
    {
      title: "Place the draft",
      input: { orderId: ID.order, customer: { name: "Ravi S", phone: "+919811111111" } },
      output: {
        orderId: ID.order,
        reference: "QO-81M3",
        status: "PLACED",
        paymentStatus: "unpaid",
        lines: [{ catalogueItemId: ID.item1, name: "Paneer tikka", quantity: 2, unitAmountPaise: 28000, lineAmountPaise: 56000 }],
        totalAmountPaise: 56000,
        currency: "INR",
        version: 2,
      },
    },
  ],
  errorCodes: [E.ORDER_NOT_FOUND, E.ORDER_INVALID_STATE, E.ORDER_VERSION_CONFLICT, E.ORDER_ITEM_UNAVAILABLE, E.ORDER_REQUIRED_FIELDS_MISSING, E.CONTACT_MISMATCH],
  defaultChannels: ALL_CHANNELS,
});

// 12. cancel_order ------------------------------------------------------------------------------

export const cancelOrder = defineTool({
  name: ToolName.CANCEL_ORDER,
  title: "Cancel an order",
  description:
    "Cancels an order that has not yet been fulfilled, if the business still allows it at its current status. " +
    "Use it only when the customer clearly asks to cancel. Ask them to confirm first. " +
    "Does not refund money, does not work on fulfilled, rejected or already cancelled orders, and cannot override the business: if cancellation is no longer possible it returns an error, so offer escalate_to_human.",
  permissionLevel: CONTROLLED_WRITE,
  requiredPermission: "orders:write",
  input: z.strictObject({
    orderId: idOf("order"),
    reason: text(0, 300, "Why the customer is cancelling.").optional(),
  }),
  output: z.object({
    orderId: z.uuid(),
    reference: z.string().max(32),
    status: z.literal(OrderStatus.CANCELLED),
    paymentStatus: paymentStatus,
    cancelledAt: z.iso.datetime({ offset: true }),
    version: z.int().min(1),
  }),
  examples: [
    {
      title: "Cancel a placed order",
      input: { orderId: ID.order, reason: "Plans changed" },
      output: { orderId: ID.order, reference: "QO-81M3", status: "CANCELLED", paymentStatus: "unpaid", cancelledAt: "2026-12-01T19:40:00+05:30", version: 3 },
    },
  ],
  errorCodes: [E.ORDER_NOT_FOUND, E.ORDER_INVALID_STATE, E.ORDER_VERSION_CONFLICT, E.CONTACT_MISMATCH],
  defaultChannels: VERIFIED_CONTACT_CHANNELS,
});

// 13. escalate_to_human -------------------------------------------------------------------------

export const escalateToHuman = defineTool({
  name: ToolName.ESCALATE_TO_HUMAN,
  title: "Hand over to a person",
  description:
    "Creates a follow-up task for the business's staff and flags the conversation so a person takes over. " +
    "Use it when the customer asks for a person, is upset, has a medical or urgent problem, wants something no other tool can do, or a tool keeps failing. Write a short summary a staff member can act on without reading the chat. " +
    "Does not solve the problem, does not contact the customer by itself, and does not promise when someone will reply. Tell the customer that the business has been told.",
  permissionLevel: WRITE,
  requiredPermission: "tasks:write",
  input: z.strictObject({
    reason: z
      .enum(["customer_asked", "complaint", "urgent_or_medical", "could_not_complete", "payment_question", "other"])
      .describe("Main reason for the handover."),
    summary: text(10, 1000, "What the customer wants and what has been done so far, in plain words."),
    urgency: z.enum(["normal", "urgent"]).default("normal"),
    bookingId: idOf("booking this is about").optional(),
    orderId: idOf("order this is about").optional(),
    customerId: idOf("customer").optional(),
  }),
  output: z.object({
    taskId: z.uuid(),
    conversationFlagged: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
  }),
  examples: [
    {
      title: "Customer asks for a person",
      input: { reason: "customer_asked", summary: "Asha wants to talk to the owner about a group booking for 12 people on 20 December." },
      output: { taskId: ID.task, conversationFlagged: true, createdAt: "2026-12-01T09:12:00+05:30" },
    },
  ],
  errorCodes: [E.BOOKING_NOT_FOUND, E.ORDER_NOT_FOUND, E.CONTACT_MISMATCH],
  defaultChannels: ALL_CHANNELS,
});

/** All tools in the order of docs/ARCHITECTURE.md section 6. */
export const ALL_TOOLS = [
  getBusinessProfile,
  searchCustomer,
  getCatalogue,
  checkAvailability,
  createBookingHold,
  confirmBooking,
  rescheduleBooking,
  cancelBooking,
  getOrderStatus,
  createOrderDraft,
  confirmOrder,
  cancelOrder,
  escalateToHuman,
] as const;
