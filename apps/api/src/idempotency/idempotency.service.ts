// Idempotency storage over the idempotency_keys table (docs/ARCHITECTURE.md section 7):
// one row per (tenant_id, key, route) with a hash of the request, an in_progress/completed status and the
// stored response, kept 24 hours.
//
// The claim (insert of the in_progress row) is committed in its own short transaction first, so a concurrent
// duplicate sees it immediately. The handler's work and the stored response are written together in the
// request's tenant transaction, so "done" and "response stored" commit atomically.
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { withTenant, type Pool } from "@qenbel/db";
import type { SqlClient } from "@qenbel/shared";
import { CONFIG, DB_POOL } from "../common/tokens.ts";
import type { AppConfig } from "../config/config.ts";

export type Claim =
  | { outcome: "owner"; id: string }
  | { outcome: "replay"; status: number; body: unknown }
  | { outcome: "different_request" }
  | { outcome: "busy" };

interface KeyRow {
  id: string;
  request_hash: string;
  status: "in_progress" | "completed";
  response_status: number | null;
  response_body: unknown;
  expired: boolean;
  stale: boolean;
  locked_at: Date;
}

/** Stable JSON: object keys sorted, so the same request body always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function requestHash(parts: { method: string; route: string; query: unknown; body: unknown }): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async claim(tenantId: string, key: string, route: string, hash: string): Promise<Claim> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await withTenant(this.pool, tenantId, async (client): Promise<Claim | "retry"> => {
        const ins = await client.query<{ id: string }>(
          `insert into idempotency_keys (tenant_id, key, route, request_hash)
           values ($1, $2, $3, $4)
           on conflict on constraint idempotency_keys_unique_key do nothing
           returning id`,
          [tenantId, key, route, hash],
        );
        const inserted = ins.rows[0];
        if (inserted) return { outcome: "owner", id: inserted.id };

        const sel = await client.query<KeyRow>(
          `select id, request_hash, status, response_status, response_body, locked_at,
                  (expires_at < now()) as expired,
                  (locked_at < now() - make_interval(secs => $4::double precision)) as stale
             from idempotency_keys
            where tenant_id = $1 and key = $2 and route = $3`,
          [tenantId, key, route, this.config.idempotency.lockTimeoutMs / 1000],
        );
        const row = sel.rows[0];
        if (!row) return "retry"; // removed between the insert and the select
        if (row.expired) {
          await client.query("delete from idempotency_keys where id = $1 and expires_at < now()", [row.id]);
          return "retry";
        }
        if (row.request_hash !== hash) return { outcome: "different_request" };
        if (row.status === "completed") {
          return { outcome: "replay", status: row.response_status ?? 200, body: row.response_body };
        }
        if (row.stale) {
          // The first attempt died without finishing. Take it over, but only one taker wins.
          const taken = await client.query(
            "update idempotency_keys set locked_at = now() where id = $1 and status = 'in_progress' and locked_at < now() - make_interval(secs => $2::double precision) returning id",
            [row.id, this.config.idempotency.lockTimeoutMs / 1000],
          );
          if (taken.rowCount === 1) return { outcome: "owner", id: row.id };
        }
        return { outcome: "busy" };
      });
      if (result !== "retry") return result;
    }
    return { outcome: "busy" };
  }

  /** Concurrent duplicate: poll until the first call finishes, or give up after IDEMPOTENCY_WAIT_MS. */
  async waitForResult(tenantId: string, key: string, route: string, hash: string): Promise<Claim> {
    const deadline = Date.now() + this.config.idempotency.waitMs;
    let claim: Claim = { outcome: "busy" };
    while (Date.now() < deadline) {
      await sleep(60);
      claim = await this.claim(tenantId, key, route, hash);
      if (claim.outcome !== "busy") return claim;
    }
    return claim;
  }

  /** In the request's own transaction: stores the response together with the handler's changes. */
  async complete(sql: SqlClient, id: string, status: number, body: unknown): Promise<void> {
    await sql.query(
      `update idempotency_keys
          set status = 'completed', response_status = $2, response_body = $3::jsonb, expires_at = now() + interval '24 hours'
        where id = $1`,
      [id, status, JSON.stringify(body ?? null)],
    );
  }

  /** After the request's transaction failed (and rolled back): remember a business error response. */
  async completeSeparately(tenantId: string, id: string, status: number, body: unknown): Promise<void> {
    await withTenant(this.pool, tenantId, (client) => this.complete(client as unknown as SqlClient, id, status, body));
  }

  /** The attempt failed in a way that should be retried from scratch: let the key go. */
  async release(tenantId: string, id: string): Promise<void> {
    await withTenant(this.pool, tenantId, (client) =>
      client.query("delete from idempotency_keys where id = $1 and status = 'in_progress'", [id]),
    );
  }
}
