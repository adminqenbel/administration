// `@Idempotent()` on a route: requires `Idempotency-Key` (8 to 128 of A-Z a-z 0-9 _ . : -), then
//   same key + same request  -> the stored status and body again, with `Idempotent-Replayed: true`
//   same key + other request -> 409 IDEMPOTENCY_CONFLICT (reason: different_request)
//   same key, still running  -> waits up to IDEMPOTENCY_WAIT_MS, then 409 IDEMPOTENCY_CONFLICT (reason: in_progress)
// Business errors (404, 409, 410, 422) are stored and replayed too. 400/401/403/429 and 5xx are not stored:
// the key is released so the client can retry.
import { applyDecorators, type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, SetMetadata, UseInterceptors } from "@nestjs/common";
import type { Request, Response } from "express";
import { from, lastValueFrom, type Observable } from "rxjs";
import { AppError, ErrorCode, idempotencyKeySchema, toErrorBody, validationError } from "@qenbel/shared";
import { reqState } from "../common/request-state.ts";
import { normalizeError } from "../errors/normalize.ts";
import { UnitOfWork } from "../tenancy/unit-of-work.service.ts";
import { IdempotencyService, requestHash } from "./idempotency.service.ts";

export const IDEMPOTENT_KEY = "qenbel:idempotent";

const NOT_STORED = new Set([400, 401, 403, 429]);

export function shouldStoreError(err: AppError): boolean {
  if (err.status >= 500) return false;
  if (NOT_STORED.has(err.status)) return false;
  if (err.details.retryable === true) return false;
  return true;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly store: IdempotencyService,
    private readonly uow: UnitOfWork,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return from(this.run(context, next));
  }

  private async run(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const state = reqState(req);
    const tenantId = state.principal?.tenantId;
    if (!tenantId) throw new AppError(ErrorCode.TENANT_REQUIRED);

    const header = req.get("idempotency-key");
    if (header === undefined || header === "") throw new AppError(ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
    const parsed = idempotencyKeySchema.safeParse(header);
    if (!parsed.success) throw validationError(parsed.error, "The Idempotency-Key header is not valid.");
    const key = parsed.data;

    const route = `${req.method} ${state.route ?? req.path}`;
    const hash = requestHash({ method: req.method, route, query: req.query, body: req.body });

    let claim = await this.store.claim(tenantId, key, route, hash);
    if (claim.outcome === "busy") claim = await this.store.waitForResult(tenantId, key, route, hash);

    switch (claim.outcome) {
      case "different_request":
        throw new AppError(ErrorCode.IDEMPOTENCY_CONFLICT, undefined, { reason: "different_request" });
      case "busy":
        throw new AppError(ErrorCode.IDEMPOTENCY_CONFLICT, undefined, { reason: "in_progress" });
      case "replay":
        res.status(claim.status);
        res.setHeader("Idempotent-Replayed", "true");
        return claim.body;
      case "owner":
        break;
    }

    const id = claim.id;
    state.idempotencyKey = key;
    return this.uow.run(req, async (tx) => {
      tx.ctx.idempotencyKey = key;
      let result: unknown;
      try {
        result = await lastValueFrom(next.handle(), { defaultValue: undefined });
      } catch (err) {
        const appError = normalizeError(err);
        try {
          if (shouldStoreError(appError)) await this.store.completeSeparately(tenantId, id, appError.status, toErrorBody(appError));
          else await this.store.release(tenantId, id);
        } catch {
          // The key stays in_progress and becomes available again after IDEMPOTENCY_LOCK_TIMEOUT_MS.
        }
        throw err;
      }
      await this.store.complete(tx.sql, id, res.statusCode, result);
      return result;
    });
  }
}

/** Marks a route as idempotent and installs the interceptor. Use on POST routes that create or change things. */
export const Idempotent = () => applyDecorators(SetMetadata(IDEMPOTENT_KEY, true), UseInterceptors(IdempotencyInterceptor));
