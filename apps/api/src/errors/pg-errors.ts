// Postgres SQLSTATE -> AppError, per docs/CONTRACT-REQUESTS.md (db agent). SQL text, constraint names, column
// names and values never reach the client; they go to the server log only.
import { AppError, ErrorCode } from "@qenbel/shared";

export interface PgLikeError {
  code: string;
  constraint?: string;
  severity?: string;
}

/** A node-postgres DatabaseError (or anything shaped like one): a five character SQLSTATE in `code`. */
export function isPgError(err: unknown): err is PgLikeError & Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return false;
  // Node system errors use codes such as ECONNRESET (not five digits/letters of SQLSTATE form, but be explicit).
  return "severity" in err || "routine" in err || "file" in err || "constraint" in err || "schema" in err;
}

export const SLOT_CONSTRAINTS: ReadonlySet<string> = new Set(["booking_allocations_no_overlap", "booking_allocations_capacity"]);
export const IDEMPOTENCY_CONSTRAINT = "idempotency_keys_unique_key";

export function mapPgError(err: PgLikeError): AppError {
  const { code, constraint } = err;
  switch (code) {
    case "23P01": // exclusion_violation
      if (constraint && SLOT_CONSTRAINTS.has(constraint)) return new AppError(ErrorCode.BOOKING_SLOT_TAKEN);
      return new AppError(ErrorCode.CONFLICT);
    case "23505": // unique_violation
      if (constraint === IDEMPOTENCY_CONSTRAINT) {
        return new AppError(ErrorCode.IDEMPOTENCY_CONFLICT, undefined, { reason: "in_progress" });
      }
      return new AppError(ErrorCode.CONFLICT, "That already exists.");
    case "23514": // check_violation
      return new AppError(ErrorCode.VALIDATION_FAILED, "A value breaks a rule for this record.");
    case "23502": // not_null_violation
    case "23503": // foreign_key_violation
    case "22P02": // invalid_text_representation (bad uuid, number)
    case "22003": // numeric_value_out_of_range
    case "22001": // string_data_right_truncation
    case "22007": // invalid_datetime_format
    case "22008": // datetime_field_overflow
    case "22023": // invalid_parameter_value
    case "22000":
      return new AppError(ErrorCode.VALIDATION_FAILED);
    case "40001": // serialization_failure
    case "40P01": // deadlock_detected
      return new AppError(ErrorCode.CONFLICT, "Another change happened at the same time. Try again.", { retryable: true });
    case "42501": // insufficient_privilege, including a row-level-security rejection
      return new AppError(ErrorCode.FORBIDDEN);
    case "57014": // query_canceled (statement timeout)
    case "57P01": // admin_shutdown
    case "57P03": // cannot_connect_now
    case "53300": // too_many_connections
      return new AppError(ErrorCode.SERVICE_UNAVAILABLE);
    case "55000": // object_not_in_prerequisite_state, raised by audit_log append-only: never expected
      return new AppError(ErrorCode.INTERNAL);
    default:
      if (code.startsWith("08") || code.startsWith("53")) return new AppError(ErrorCode.SERVICE_UNAVAILABLE);
      return new AppError(ErrorCode.INTERNAL);
  }
}
