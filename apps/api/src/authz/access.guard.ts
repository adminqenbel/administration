// The single gate in front of every route (registered globally). Deny by default:
//   1. no declared access policy on the route            -> 403 (and an error in the log; a test also fails)
//   2. per-address rate limit
//   3. @Public()                                         -> let through
//   4. brute-force lockout, then authenticate (Bearer session token or API credential)
//   5. authorise against the declared policy             -> 403 + audit row (outcome denied)
//   6. per-principal rate limit
//   7. refuse any tenant/organisation id in the query or body
// Tenant, role and permissions exist only on the Principal this guard builds.
import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import { AppError, AuditOutcome, ErrorCode } from "@qenbel/shared";
import { AuditService } from "../audit/audit.service.ts";
import { AuthFailure, AuthenticationService } from "../auth/authentication.service.ts";
import type { Principal } from "../auth/principal.ts";
import { principalId } from "../auth/principal.ts";
import { clientIp, reqState } from "../common/request-state.ts";
import { AppLogger } from "../common/logger.ts";
import { CONFIG, LOGGER, RATE_LIMITER } from "../common/tokens.ts";
import type { AppConfig } from "../config/config.ts";
import type { RateLimiter, RateLimitResult } from "../ratelimit/rate-limiter.ts";
import { ACCESS_KEY, ALLOW_CREDENTIAL_KEY, type AccessPolicy } from "./decorators.ts";

const TENANT_KEY_HINTS = ["tenantid", "orgid", "organizationid", "organisationid"];

function looksLikeTenantKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return TENANT_KEY_HINTS.some((hint) => flat.includes(hint));
}

/** Depth- and size-bounded scan. Throws VALIDATION_FAILED without echoing any value. */
export function assertNoTenantKeys(value: unknown, depth = 0, budget = { n: 0 }): void {
  if (value === null || typeof value !== "object" || depth > 8) return;
  if (++budget.n > 5000) return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoTenantKeys(item, depth + 1, budget);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (looksLikeTenantKey(k)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, "The business is taken from your sign-in. Do not send a tenant or organisation id.", {
        issues: [{ path: "tenantId", code: "unrecognized_keys", message: "Not accepted. The tenant comes from the signed-in principal." }],
      });
    }
    assertNoTenantKeys(v, depth + 1, budget);
  }
}

export function decide(policy: AccessPolicy, principal: Principal, allowCredential: boolean): { ok: true } | { ok: false; reason: string } {
  if (principal.kind === "api_credential" && !allowCredential) return { ok: false, reason: "credential_not_allowed_on_route" };
  switch (policy.kind) {
    case "public":
    case "authenticated":
      return { ok: true };
    case "platform_admin":
      return principal.isPlatformAdmin ? { ok: true } : { ok: false, reason: "not_platform_admin" };
    case "permission":
      return principal.permissions.includes(policy.permission) ? { ok: true } : { ok: false, reason: "missing_permission" };
  }
}

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authn: AuthenticationService,
    private readonly audit: AuditService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return false;
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const state = reqState(req);
    const route = (req.baseUrl ?? "") + ((req.route as { path?: string } | undefined)?.path ?? req.path);
    state.route = route;

    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (!policy) {
      this.logger.error("route has no declared access policy: refused", { route, method: req.method });
      throw new AppError(ErrorCode.FORBIDDEN);
    }
    const allowCredential = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_CREDENTIAL_KEY, [context.getHandler(), context.getClass()]) === true;

    const rl = this.config.rateLimit;
    const ip = clientIp(req);
    const isPublic = policy.kind === "public";
    this.applyLimit(res, await this.limiter.hit(`${isPublic ? "pub" : "ip"}:${ip}`, isPublic ? rl.publicMax : rl.ipMax, rl.windowSeconds));

    if (isPublic) {
      assertNoTenantKeys(req.query);
      assertNoTenantKeys(req.body);
      return true;
    }

    const lockout = await this.limiter.peek(`authfail:${ip}`, rl.authFailMax);
    if (!lockout.allowed) throw this.tooMany(res, lockout);

    let principal: Principal;
    try {
      principal = await this.authn.authenticate(req.get("authorization"), req.socket.remoteAddress);
    } catch (err) {
      if (err instanceof AuthFailure) {
        await this.limiter.hit(`authfail:${ip}`, rl.authFailMax, rl.windowSeconds);
        this.logger.warn("access refused", { requestId: state.requestId, route, reason: err.reason });
      }
      throw err;
    }
    state.principal = principal;

    const verdict = decide(policy, principal, allowCredential);
    if (!verdict.ok) {
      this.logger.warn("access denied", { requestId: state.requestId, route, principalKind: principal.kind, reason: verdict.reason });
      if (principal.tenantId) {
        await this.audit.recordSeparately({
          tenantId: principal.tenantId,
          actorKind: principal.kind,
          actorId: principalId(principal),
          action: "authz.denied",
          outcome: AuditOutcome.DENIED,
          channel: principal.channel,
          requestId: state.requestId,
          ip,
          details: {
            method: req.method,
            route,
            required: policy.kind === "permission" ? policy.permission : policy.kind,
            reason: verdict.reason,
          },
        });
      }
      throw new AppError(ErrorCode.FORBIDDEN);
    }

    const pr = await this.limiter.hit(`p:${principal.tenantId ?? "-"}:${principalId(principal)}`, rl.principalMax, rl.windowSeconds);
    if (!pr.allowed) throw this.tooMany(res, pr);
    this.applyLimit(res, pr);

    assertNoTenantKeys(req.query);
    assertNoTenantKeys(req.body);
    return true;
  }

  private applyLimit(res: Response, r: RateLimitResult): void {
    res.setHeader("RateLimit-Limit", String(r.limit));
    res.setHeader("RateLimit-Remaining", String(r.remaining));
    res.setHeader("RateLimit-Reset", String(r.resetSeconds));
    if (!r.allowed) throw this.tooMany(res, r);
  }

  private tooMany(res: Response, r: RateLimitResult): AppError {
    res.setHeader("RateLimit-Limit", String(r.limit));
    res.setHeader("RateLimit-Remaining", "0");
    res.setHeader("RateLimit-Reset", String(r.resetSeconds));
    return new AppError(ErrorCode.RATE_LIMITED, undefined, { retryAfterSeconds: r.resetSeconds });
  }
}
