// Contract enums. Values are stored as text with CHECK constraints in the database.
// Do not change without the coordinator: db, api, packs, tool-registry and web all depend on these.

export const BookingStatus = {
  HOLD: "HOLD",
  CONFIRMED: "CONFIRMED",
  CHECKED_IN: "CHECKED_IN",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
  NO_SHOW: "NO_SHOW",
} as const;
export type BookingStatus = (typeof BookingStatus)[keyof typeof BookingStatus];

export const OrderStatus = {
  DRAFT: "DRAFT",
  PLACED: "PLACED",
  ACCEPTED: "ACCEPTED",
  PROCESSING: "PROCESSING",
  READY: "READY",
  FULFILLED: "FULFILLED",
  CANCELLED: "CANCELLED",
  REJECTED: "REJECTED",
  REFUNDED: "REFUNDED",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const UserRole = {
  OWNER: "OWNER",
  MANAGER: "MANAGER",
  STAFF: "STAFF",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const PrincipalKind = {
  USER: "user",
  API_CREDENTIAL: "api_credential",
  SYSTEM: "system",
  PLATFORM_ADMIN: "platform_admin",
} as const;
export type PrincipalKind = (typeof PrincipalKind)[keyof typeof PrincipalKind];

export const ToolPermissionLevel = {
  READ: "READ",
  WRITE: "WRITE",
  CONTROLLED_WRITE: "CONTROLLED_WRITE",
} as const;
export type ToolPermissionLevel = (typeof ToolPermissionLevel)[keyof typeof ToolPermissionLevel];

export const ToolName = {
  GET_BUSINESS_PROFILE: "get_business_profile",
  SEARCH_CUSTOMER: "search_customer",
  GET_CATALOGUE: "get_catalogue",
  CHECK_AVAILABILITY: "check_availability",
  CREATE_BOOKING_HOLD: "create_booking_hold",
  CONFIRM_BOOKING: "confirm_booking",
  RESCHEDULE_BOOKING: "reschedule_booking",
  CANCEL_BOOKING: "cancel_booking",
  GET_ORDER_STATUS: "get_order_status",
  CREATE_ORDER_DRAFT: "create_order_draft",
  CONFIRM_ORDER: "confirm_order",
  CANCEL_ORDER: "cancel_order",
  ESCALATE_TO_HUMAN: "escalate_to_human",
} as const;
export type ToolName = (typeof ToolName)[keyof typeof ToolName];

export const Channel = {
  WEB_CHAT: "web_chat",
  WHATSAPP: "whatsapp",
  VOICE: "voice",
  API: "api",
  DASHBOARD: "dashboard",
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

export const BookingMode = {
  SLOT: "slot",
  TABLE: "table",
  ROOM: "room",
  PERIOD: "period",
  NONE: "none",
} as const;
export type BookingMode = (typeof BookingMode)[keyof typeof BookingMode];

export const OrderMode = {
  CATALOGUE: "catalogue",
  DINE_IN: "dine_in",
  QUOTE: "quote",
  RENTAL: "rental",
  NONE: "none",
} as const;
export type OrderMode = (typeof OrderMode)[keyof typeof OrderMode];

export const ResourceType = {
  STAFF: "staff",
  ROOM: "room",
  TABLE: "table",
  EQUIPMENT: "equipment",
  DOCTOR: "doctor",
  VEHICLE: "vehicle",
} as const;
export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

export const WebhookEvent = {
  BOOKING_CREATED: "booking.created",
  BOOKING_CONFIRMED: "booking.confirmed",
  BOOKING_RESCHEDULED: "booking.rescheduled",
  BOOKING_CANCELLED: "booking.cancelled",
  BOOKING_NO_SHOW: "booking.no_show",
  BOOKING_COMPLETED: "booking.completed",
  ORDER_CREATED: "order.created",
  ORDER_ACCEPTED: "order.accepted",
  ORDER_FULFILLED: "order.fulfilled",
  ORDER_CANCELLED: "order.cancelled",
  CUSTOMER_CREATED: "customer.created",
  PAYMENT_COMPLETED: "payment.completed",
} as const;
export type WebhookEvent = (typeof WebhookEvent)[keyof typeof WebhookEvent];

export const PaymentStatus = {
  UNPAID: "unpaid",
  PARTIAL: "partial",
  PAID: "paid",
  REFUNDED: "refunded",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];
