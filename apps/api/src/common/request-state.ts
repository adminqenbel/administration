import type { Request } from "express";
import type { EngineContext, SqlClient } from "@qenbel/shared";
import type { Principal } from "../auth/principal.ts";

/** What handlers receive for tenant work: the transaction-bound SQL client and the engine context. */
export interface TenantTx {
  readonly tenantId: string;
  readonly sql: SqlClient;
  readonly ctx: EngineContext;
}

export interface RequestState {
  requestId: string;
  startedAt: number;
  principal?: Principal;
  tx?: TenantTx;
  /** Route template once known, for logs ("/v1/business/profile"). */
  route?: string;
  idempotencyKey?: string;
}

const STATE = Symbol.for("qenbel.requestState");

/** Per-request state kept in one place instead of augmenting Express types. */
export function reqState(req: Request): RequestState {
  const holder = req as unknown as Record<symbol, RequestState | undefined>;
  let s = holder[STATE];
  if (!s) {
    s = { requestId: "", startedAt: Date.now() };
    holder[STATE] = s;
  }
  return s;
}

/** Client address as Express sees it (honours TRUST_PROXY). */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}
