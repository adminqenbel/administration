// One request = one tenant transaction. `run` opens a `withTenant` transaction
// (BEGIN; select set_config('app.tenant_id', $1, true)) for the request's principal, exposes the
// transaction-bound client and the engine context as `state.tx` (read with `@Tx()`), and commits when `fn`
// returns or rolls back when it throws. GET/HEAD run READ ONLY, so a read route cannot change data.
//
// The tenant id is `principal.tenantId`, set by the access guard from the database row of the verified
// identity. There is no other source.
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { withTenant, type Pool } from "@qenbel/db";
import type { EngineContext, SqlClient } from "@qenbel/shared";
import { principalId } from "../auth/principal.ts";
import { type TenantTx, reqState } from "../common/request-state.ts";
import { CLOCK, DB_POOL } from "../common/tokens.ts";

@Injectable()
export class UnitOfWork {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: () => Date,
  ) {}

  async run<T>(req: Request, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const state = reqState(req);
    const principal = state.principal;
    if (!principal || principal.tenantId === null) throw new Error("UnitOfWork.run needs a principal with a tenant");
    const tenantId = principal.tenantId;
    const readOnly = req.method === "GET" || req.method === "HEAD";
    return withTenant(
      this.pool,
      tenantId,
      async (client) => {
        const ctx: EngineContext = {
          tenantId,
          actor: { kind: principal.kind, id: principalId(principal), channel: principal.channel },
          now: this.clock,
          newId: randomUUID,
        };
        const tx: TenantTx = { tenantId, sql: client as unknown as SqlClient, ctx };
        state.tx = tx;
        try {
          return await fn(tx);
        } finally {
          state.tx = undefined;
        }
      },
      { readOnly },
    );
  }
}
