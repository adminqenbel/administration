import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from "@nestjs/common";
import type { Request, Response } from "express";
import { AppError, ErrorCode, toErrorBody } from "@qenbel/shared";
import { LOGGER } from "../common/tokens.ts";
import { AppLogger, errorFields } from "../common/logger.ts";
import { reqState } from "../common/request-state.ts";
import { normalizeError } from "./normalize.ts";

/** Every error leaves the API as { error: { code, message, details } } and nothing else. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== "http") return;
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const appError = normalizeError(exception);

    const status = appError.status;
    if (status >= 500 || appError.code === ErrorCode.INTERNAL) {
      // Full detail goes to the server log only (scrubbed), correlated by request id.
      this.logger.error("request failed", { requestId: reqState(req).requestId, err: errorFields(exception), code: appError.code });
    }

    if (res.headersSent) {
      res.end();
      return;
    }
    if (appError.code === ErrorCode.RATE_LIMITED) {
      const retry = appError.details.retryAfterSeconds;
      if (typeof retry === "number") res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retry))));
    }
    if (appError.code === ErrorCode.IDEMPOTENCY_CONFLICT && appError.details.reason === "in_progress") {
      res.setHeader("Retry-After", "1");
    }
    res.status(status).json(toErrorBody(appError));
  }
}

export { AppError };
