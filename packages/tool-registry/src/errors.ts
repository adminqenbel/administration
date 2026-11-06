// Tool-level error codes. Local to the registry until `@qenbel/shared` publishes the
// platform-wide list; names follow the `{ error: { code, message, details } }` shape.

export const ToolErrorCode = {
  // Common: any tool call can return these.
  VALIDATION_FAILED: "VALIDATION_FAILED",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  IDEMPOTENCY_KEY_IN_USE: "IDEMPOTENCY_KEY_IN_USE",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  TOOL_NOT_ALLOWED: "TOOL_NOT_ALLOWED",
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // Specific.
  CONTACT_MISMATCH: "CONTACT_MISMATCH",
  CATALOGUE_ITEM_NOT_FOUND: "CATALOGUE_ITEM_NOT_FOUND",
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
  LOCATION_NOT_FOUND: "LOCATION_NOT_FOUND",
  BOOKING_NOT_FOUND: "BOOKING_NOT_FOUND",
  BOOKING_MODE_NOT_SUPPORTED: "BOOKING_MODE_NOT_SUPPORTED",
  BOOKING_SLOT_TAKEN: "BOOKING_SLOT_TAKEN",
  BOOKING_OUTSIDE_HOURS: "BOOKING_OUTSIDE_HOURS",
  BOOKING_OUTSIDE_WINDOW: "BOOKING_OUTSIDE_WINDOW",
  BOOKING_HOLD_EXPIRED: "BOOKING_HOLD_EXPIRED",
  BOOKING_INVALID_STATE: "BOOKING_INVALID_STATE",
  BOOKING_VERSION_CONFLICT: "BOOKING_VERSION_CONFLICT",
  BOOKING_REQUIRED_FIELDS_MISSING: "BOOKING_REQUIRED_FIELDS_MISSING",
  BOOKING_CANCEL_NOT_ALLOWED: "BOOKING_CANCEL_NOT_ALLOWED",
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  ORDER_MODE_NOT_SUPPORTED: "ORDER_MODE_NOT_SUPPORTED",
  ORDER_ITEM_UNAVAILABLE: "ORDER_ITEM_UNAVAILABLE",
  ORDER_INVALID_STATE: "ORDER_INVALID_STATE",
  ORDER_VERSION_CONFLICT: "ORDER_VERSION_CONFLICT",
  ORDER_REQUIRED_FIELDS_MISSING: "ORDER_REQUIRED_FIELDS_MISSING",
} as const;
export type ToolErrorCode = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

export interface ToolErrorInfo {
  httpStatus: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;
  /** Default message. Plain, short, safe to show to a customer. */
  message: string;
}

export const TOOL_ERROR_CATALOGUE: Readonly<Record<ToolErrorCode, ToolErrorInfo>> = {
  VALIDATION_FAILED: { httpStatus: 400, message: "Some of the details are missing or not in the right format." },
  IDEMPOTENCY_KEY_REQUIRED: { httpStatus: 400, message: "This call changes data and needs an Idempotency-Key header." },
  IDEMPOTENCY_KEY_IN_USE: { httpStatus: 409, message: "A call with this Idempotency-Key is still running." },
  IDEMPOTENCY_KEY_REUSED: { httpStatus: 422, message: "This Idempotency-Key was already used with different details." },
  UNAUTHENTICATED: { httpStatus: 401, message: "The API key is missing, wrong or revoked." },
  FORBIDDEN: { httpStatus: 403, message: "This key is not allowed to do that." },
  TOOL_NOT_ALLOWED: { httpStatus: 403, message: "This tool is not turned on for this business or this key." },
  TOOL_NOT_FOUND: { httpStatus: 404, message: "There is no tool with that name." },
  RATE_LIMITED: { httpStatus: 429, message: "Too many requests. Wait a moment and try again." },
  INTERNAL_ERROR: { httpStatus: 500, message: "Something went wrong on our side." },
  CONTACT_MISMATCH: { httpStatus: 403, message: "This record does not belong to the person in this conversation." },
  CATALOGUE_ITEM_NOT_FOUND: { httpStatus: 404, message: "That item is not in the catalogue." },
  RESOURCE_NOT_FOUND: { httpStatus: 404, message: "That staff member, room or table was not found." },
  LOCATION_NOT_FOUND: { httpStatus: 404, message: "That location was not found." },
  BOOKING_NOT_FOUND: { httpStatus: 404, message: "That booking was not found." },
  BOOKING_MODE_NOT_SUPPORTED: { httpStatus: 422, message: "This business does not take bookings this way." },
  BOOKING_SLOT_TAKEN: { httpStatus: 409, message: "That time is no longer free." },
  BOOKING_OUTSIDE_HOURS: { httpStatus: 422, message: "That time is outside opening hours." },
  BOOKING_OUTSIDE_WINDOW: { httpStatus: 422, message: "That time is too soon or too far ahead to book." },
  BOOKING_HOLD_EXPIRED: { httpStatus: 409, message: "The hold has run out. Check the times again." },
  BOOKING_INVALID_STATE: { httpStatus: 409, message: "The booking is not in a state that allows this." },
  BOOKING_VERSION_CONFLICT: { httpStatus: 409, message: "The booking changed since it was read. Read it again." },
  BOOKING_REQUIRED_FIELDS_MISSING: { httpStatus: 422, message: "Some details needed for this booking are missing." },
  BOOKING_CANCEL_NOT_ALLOWED: { httpStatus: 422, message: "This booking can no longer be cancelled online." },
  ORDER_NOT_FOUND: { httpStatus: 404, message: "That order was not found." },
  ORDER_MODE_NOT_SUPPORTED: { httpStatus: 422, message: "This business does not take orders this way." },
  ORDER_ITEM_UNAVAILABLE: { httpStatus: 422, message: "One or more items are not available." },
  ORDER_INVALID_STATE: { httpStatus: 409, message: "The order is not in a state that allows this." },
  ORDER_VERSION_CONFLICT: { httpStatus: 409, message: "The order changed since it was read. Read it again." },
  ORDER_REQUIRED_FIELDS_MISSING: { httpStatus: 422, message: "Some details needed for this order are missing." },
};

/** Codes every tool call can return; listed once in the OpenAPI document instead of per tool. */
export const COMMON_ERROR_CODES = [
  ToolErrorCode.VALIDATION_FAILED,
  ToolErrorCode.UNAUTHENTICATED,
  ToolErrorCode.FORBIDDEN,
  ToolErrorCode.TOOL_NOT_ALLOWED,
  ToolErrorCode.TOOL_NOT_FOUND,
  ToolErrorCode.RATE_LIMITED,
  ToolErrorCode.INTERNAL_ERROR,
] as const satisfies readonly ToolErrorCode[];

/** Extra common codes for tools that require an Idempotency-Key. */
export const IDEMPOTENCY_ERROR_CODES = [
  ToolErrorCode.IDEMPOTENCY_KEY_REQUIRED,
  ToolErrorCode.IDEMPOTENCY_KEY_IN_USE,
  ToolErrorCode.IDEMPOTENCY_KEY_REUSED,
] as const satisfies readonly ToolErrorCode[];
