// Error codes, AppError and the wire format: { error: { code, message, details } }.
import { z } from "zod";

export const ErrorCode = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  TENANT_REQUIRED: "TENANT_REQUIRED",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  REQUIRED_FIELDS_MISSING: "REQUIRED_FIELDS_MISSING",
  CONFLICT: "CONFLICT",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  BOOKING_SLOT_TAKEN: "BOOKING_SLOT_TAKEN",
  HOLD_EXPIRED: "HOLD_EXPIRED",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  TOOL_NOT_ENABLED: "TOOL_NOT_ENABLED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  PACK_INVALID: "PACK_INVALID",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_CODES = Object.values(ErrorCode) as readonly ErrorCode[];

/** HTTP status the API maps each code to. */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  TENANT_REQUIRED: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  REQUIRED_FIELDS_MISSING: 422,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  BOOKING_SLOT_TAKEN: 409,
  HOLD_EXPIRED: 410,
  INVALID_TRANSITION: 409,
  TOOL_NOT_ENABLED: 403,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  PACK_INVALID: 422,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: "Sign in to continue.",
  FORBIDDEN: "You do not have permission to do this.",
  TENANT_REQUIRED: "No business is selected for this request.",
  NOT_FOUND: "Not found.",
  VALIDATION_FAILED: "The request is not valid.",
  REQUIRED_FIELDS_MISSING: "Some required details are missing.",
  CONFLICT: "This conflicts with the current state.",
  VERSION_CONFLICT: "This record changed. Reload and try again.",
  BOOKING_SLOT_TAKEN: "That time is no longer available.",
  HOLD_EXPIRED: "The hold has expired.",
  INVALID_TRANSITION: "That change is not allowed from the current status.",
  TOOL_NOT_ENABLED: "This tool is not enabled.",
  IDEMPOTENCY_CONFLICT: "This idempotency key was used with a different request.",
  IDEMPOTENCY_KEY_REQUIRED: "An Idempotency-Key header is required.",
  RATE_LIMITED: "Too many requests. Try again shortly.",
  PAYLOAD_TOO_LARGE: "The request is too large.",
  PACK_INVALID: "The config pack is not valid.",
  SERVICE_UNAVAILABLE: "The service is unavailable. Try again shortly.",
  INTERNAL: "Something went wrong.",
};

export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message?: string, details: ErrorDetails = {}) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  toBody(): ErrorBody {
    return toErrorBody(this);
  }
}

export const errorBodySchema = z.object({
  error: z.object({
    code: z.enum(ErrorCode),
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Wire format. Unknown errors become INTERNAL with no detail leaked. */
export function toErrorBody(err: unknown): ErrorBody {
  if (isAppError(err)) {
    return { error: { code: err.code, message: err.message, details: err.details } };
  }
  return { error: { code: ErrorCode.INTERNAL, message: DEFAULT_MESSAGES.INTERNAL, details: {} } };
}

export function errorStatus(err: unknown): number {
  return isAppError(err) ? err.status : ERROR_HTTP_STATUS.INTERNAL;
}

/** Convert a zod error to VALIDATION_FAILED. Input values are never echoed. */
export function validationError(error: z.ZodError, message?: string): AppError {
  const issues = error.issues.map((i) => ({
    path: i.path.map((p) => String(p)).join("."),
    code: i.code,
    message: i.message,
  }));
  return new AppError(ErrorCode.VALIDATION_FAILED, message, { issues });
}

/** Parse with a zod schema; throws AppError(VALIDATION_FAILED) on failure. */
export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}
