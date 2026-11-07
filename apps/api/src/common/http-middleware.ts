import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AppError, ErrorCode } from "@qenbel/shared";
import type { AppConfig } from "../config/config.ts";
import type { AppLogger } from "./logger.ts";
import { reqState } from "./request-state.ts";

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Accepts a well-formed X-Request-Id from the caller (for tracing), otherwise makes one. */
export function requestId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.get("x-request-id");
    const id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    const state = reqState(req);
    state.requestId = id;
    state.startedAt = Date.now();
    res.setHeader("X-Request-Id", id);
    next();
  };
}

/** One structured line per request. No headers, no query string, no body. */
export function accessLog(logger: AppLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on("finish", () => {
      const s = reqState(req);
      logger.info("request", {
        requestId: s.requestId,
        method: req.method,
        route: s.route ?? "(unmatched)",
        status: res.statusCode,
        durationMs: Date.now() - s.startedAt,
        principalKind: s.principal?.kind,
        tenantId: s.principal?.tenantId ?? undefined,
      });
    });
    next();
  };
}

export function securityHeaders(config: AppConfig) {
  const hsts = config.nodeEnv === "production";
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader("Cache-Control", "no-store");
    if (hsts) res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    next();
  };
}

const CORS_ALLOWED_HEADERS = "Authorization, Content-Type, Idempotency-Key, X-Request-Id";
const CORS_EXPOSED_HEADERS = "X-Request-Id, Idempotent-Replayed, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After";

/**
 * CORS for the QenBel web app only: one exact origin, no wildcard, no credentials (the API uses a Bearer
 * token, never a cookie, so a cross-site page cannot ride on a browser session). Any other Origin gets no
 * CORS headers, so the browser blocks the response.
 */
export function cors(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get("origin");
    if (origin !== undefined) {
      res.vary("Origin");
      if (origin === config.publicWebOrigin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS);
        if (req.method === "OPTIONS") {
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
          res.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
          res.setHeader("Access-Control-Max-Age", "600");
        }
      }
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** State-changing requests that carry a body must be JSON. A plain HTML form cannot send that cross-site. */
export function requireJsonBody() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const method = req.method;
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
      const length = req.get("content-length");
      const hasBody = (length !== undefined && length !== "0") || req.get("transfer-encoding") !== undefined;
      if (hasBody) {
        const type = (req.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
        if (type !== "application/json") {
          next(new AppError(ErrorCode.VALIDATION_FAILED, "Send the request as JSON (Content-Type: application/json)."));
          return;
        }
      }
    }
    next();
  };
}
