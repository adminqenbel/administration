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
  BOOKING_EXPIRED: "booking.expired",
  ORDER_CREATED: "order.created",
  ORDER_ACCEPTED: "order.accepted",
  ORDER_FULFILLED: "order.fulfilled",
  ORDER_CANCELLED: "order.cancelled",
  ORDER_REJECTED: "order.rejected",
  CUSTOMER_CREATED: "customer.created",
  PAYMENT_COMPLETED: "payment.completed",
  PAYMENT_REFUNDED: "payment.refunded",
} as const;
export type WebhookEvent = (typeof WebhookEvent)[keyof typeof WebhookEvent];

export const PaymentStatus = {
  UNPAID: "unpaid",
  PARTIAL: "partial",
  PAID: "paid",
  REFUNDED: "refunded",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

// ---- Operational enums (match the database CHECK constraints in packages/db/migrations) ----

export const DeploymentMode = {
  CENTRAL: "central",
  ISOLATED: "isolated",
} as const;
export type DeploymentMode = (typeof DeploymentMode)[keyof typeof DeploymentMode];

export const TenantStatus = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  ARCHIVED: "archived",
} as const;
export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];

export const AuthProviderKind = {
  DEV: "dev",
  CLERK: "clerk",
} as const;
export type AuthProviderKind = (typeof AuthProviderKind)[keyof typeof AuthProviderKind];

export const ConversationStatus = {
  OPEN: "open",
  ESCALATED: "escalated",
  CLOSED: "closed",
} as const;
export type ConversationStatus = (typeof ConversationStatus)[keyof typeof ConversationStatus];

export const MessageRole = {
  USER: "user",
  ASSISTANT: "assistant",
  TOOL: "tool",
  SYSTEM: "system",
} as const;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

export const FollowUpStatus = {
  OPEN: "open",
  DONE: "done",
  CANCELLED: "cancelled",
} as const;
export type FollowUpStatus = (typeof FollowUpStatus)[keyof typeof FollowUpStatus];

export const FollowUpOrigin = {
  STAFF: "staff",
  AI_ESCALATION: "ai_escalation",
  SYSTEM: "system",
} as const;
export type FollowUpOrigin = (typeof FollowUpOrigin)[keyof typeof FollowUpOrigin];

export const OutboxStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  DELIVERED: "delivered",
  FAILED: "failed",
  DEAD: "dead",
} as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

export const WebhookDeliveryStatus = {
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
} as const;
export type WebhookDeliveryStatus = (typeof WebhookDeliveryStatus)[keyof typeof WebhookDeliveryStatus];

export const NotificationChannel = {
  EMAIL: "email",
  WHATSAPP: "whatsapp",
  SMS: "sms",
  IN_APP: "in_app",
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const NotificationStatus = {
  QUEUED: "queued",
  SENDING: "sending",
  SENT: "sent",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type NotificationStatus = (typeof NotificationStatus)[keyof typeof NotificationStatus];

export const PaymentKind = {
  PAYMENT: "payment",
  REFUND: "refund",
} as const;
export type PaymentKind = (typeof PaymentKind)[keyof typeof PaymentKind];

export const PaymentMethod = {
  CASH: "cash",
  CARD: "card",
  UPI: "upi",
  BANK_TRANSFER: "bank_transfer",
  ONLINE: "online",
  OTHER: "other",
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PaymentEntryStatus = {
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type PaymentEntryStatus = (typeof PaymentEntryStatus)[keyof typeof PaymentEntryStatus];

export const FulfilmentType = {
  PICKUP: "pickup",
  DELIVERY: "delivery",
  DINE_IN: "dine_in",
  ON_SITE: "on_site",
} as const;
export type FulfilmentType = (typeof FulfilmentType)[keyof typeof FulfilmentType];

export const FulfilmentStatus = {
  PENDING: "pending",
  SCHEDULED: "scheduled",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type FulfilmentStatus = (typeof FulfilmentStatus)[keyof typeof FulfilmentStatus];

export const CatalogueItemKind = {
  SERVICE: "service",
  PRODUCT: "product",
} as const;
export type CatalogueItemKind = (typeof CatalogueItemKind)[keyof typeof CatalogueItemKind];

export const AllocationMode = {
  EXCLUSIVE: "exclusive",
  SHARED: "shared",
} as const;
export type AllocationMode = (typeof AllocationMode)[keyof typeof AllocationMode];

export const AuditOutcome = {
  SUCCESS: "success",
  DENIED: "denied",
  ERROR: "error",
} as const;
export type AuditOutcome = (typeof AuditOutcome)[keyof typeof AuditOutcome];

export const CredentialType = {
  API_KEY: "api_key",
  WIDGET_KEY: "widget_key",
} as const;
export type CredentialType = (typeof CredentialType)[keyof typeof CredentialType];

export const IdempotencyStatus = {
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
} as const;
export type IdempotencyStatus = (typeof IdempotencyStatus)[keyof typeof IdempotencyStatus];

export const DiscountType = {
  FIXED: "fixed",
  PERCENT_BPS: "percent_bps",
} as const;
export type DiscountType = (typeof DiscountType)[keyof typeof DiscountType];
