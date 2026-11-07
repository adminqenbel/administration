// Route access markers. Every route must carry exactly one of:
//   @Permission("bookings:read")   a signed-in principal holding that permission
//   @Authenticated()               any signed-in principal (no particular permission), e.g. GET /v1/me
//   @PlatformAdmin()               a platform admin (platform:admin), no tenant data
//   @Public()                      no principal; rate limited by client address
// A route with none of them is refused by the guard and fails the route-permission test.
// API credentials are refused everywhere unless the route also says @AllowApiCredential().
import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Request } from "express";
import { AppError, ErrorCode } from "@qenbel/shared";
import { reqState, type TenantTx } from "../common/request-state.ts";
import type { Principal } from "../auth/principal.ts";
import { type ApiPermission, isApiPermission } from "./permissions.ts";

export const ACCESS_KEY = "qenbel:access";
export const ALLOW_CREDENTIAL_KEY = "qenbel:allow-api-credential";

export type AccessPolicy =
  | { kind: "public" }
  | { kind: "authenticated" }
  | { kind: "platform_admin" }
  | { kind: "permission"; permission: ApiPermission };

export const Public = () => SetMetadata(ACCESS_KEY, { kind: "public" } satisfies AccessPolicy);
export const Authenticated = () => SetMetadata(ACCESS_KEY, { kind: "authenticated" } satisfies AccessPolicy);
export const PlatformAdmin = () => SetMetadata(ACCESS_KEY, { kind: "platform_admin" } satisfies AccessPolicy);
export const Permission = (permission: ApiPermission) => {
  // A typo is caught when the module loads, not when a user hits the route.
  if (!isApiPermission(permission)) throw new Error(`Unknown permission "${String(permission)}"`);
  return SetMetadata(ACCESS_KEY, { kind: "permission", permission } satisfies AccessPolicy);
};
export const AllowApiCredential = () => SetMetadata(ALLOW_CREDENTIAL_KEY, true);

/** The authenticated principal. Throws UNAUTHENTICATED on a route that did not authenticate. */
export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const p = reqState(ctx.switchToHttp().getRequest<Request>()).principal;
  if (!p) throw new AppError(ErrorCode.UNAUTHENTICATED);
  return p;
});

/** The request's tenant unit of work: SqlClient (inside withTenant) plus EngineContext. */
export const Tx = createParamDecorator((_data: unknown, ctx: ExecutionContext): TenantTx => {
  const tx = reqState(ctx.switchToHttp().getRequest<Request>()).tx;
  if (!tx) throw new AppError(ErrorCode.TENANT_REQUIRED);
  return tx;
});

/** Request metadata (id, client address) for audit entries. */
export interface RequestMeta {
  requestId: string;
  ip: string | null;
}

export const ReqMeta = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { requestId: reqState(req).requestId, ip: req.ip ?? null };
});

/** Like `@Tx()` but undefined when the principal has no tenant (a platform admin outside any business). */
export const OptionalTx = createParamDecorator((_data: unknown, ctx: ExecutionContext): TenantTx | undefined => {
  return reqState(ctx.switchToHttp().getRequest<Request>()).tx;
});
