import { HttpException } from "@nestjs/common";
import { ZodError } from "zod";
import { AppError, ErrorCode, validationError } from "@qenbel/shared";
import { isPgError, mapPgError } from "./pg-errors.ts";

function fromStatus(status: number): AppError {
  switch (status) {
    case 401:
      return new AppError(ErrorCode.UNAUTHENTICATED);
    case 403:
      return new AppError(ErrorCode.FORBIDDEN);
    case 404:
    case 405:
      return new AppError(ErrorCode.NOT_FOUND);
    case 413:
      return new AppError(ErrorCode.PAYLOAD_TOO_LARGE);
    case 429:
      return new AppError(ErrorCode.RATE_LIMITED);
    default:
      if (status >= 400 && status < 500) return new AppError(ErrorCode.VALIDATION_FAILED);
      return new AppError(ErrorCode.INTERNAL);
  }
}

/**
 * Any thrown value -> the AppError a client may see. Messages from HttpException, body-parser and pg are
 * not forwarded: they can echo input or internals.
 */
export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return validationError(err);
  if (err instanceof HttpException) return fromStatus(err.getStatus());
  if (isPgError(err)) return mapPgError(err);
  // body-parser style errors that did not pass through Nest's mapping
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; statusCode?: unknown; type?: unknown };
    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
    if (status !== undefined && typeof e.type === "string" && e.type.startsWith("entity.")) return fromStatus(status);
  }
  return new AppError(ErrorCode.INTERNAL);
}
