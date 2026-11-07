// Routes that exist only in tests. They exercise the guard, the unit of work, idempotency and the error filter
// the way Stage 3 controllers will.
import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { AppError, ErrorCode, type SqlClient } from "@qenbel/shared";
import { Permission, Public, Tx } from "../../src/authz/decorators.ts";
import { ApiPermission } from "../../src/authz/permissions.ts";
import type { TenantTx } from "../../src/common/request-state.ts";
import { Idempotent } from "../../src/idempotency/idempotency.interceptor.ts";

export const counters = { idem: 0, slow: 0, flaky: 0 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function insertCustomer(sql: SqlClient, tenantId: string, name: string): Promise<string> {
  const r = await sql.query<{ id: string }>("insert into customers (tenant_id, name, phone) values ($1, $2, $3) returning id", [
    tenantId,
    name,
    `+9190000${Math.floor(Math.random() * 90000 + 10000)}`,
  ]);
  return (r.rows[0] as { id: string }).id;
}

@Controller("test")
export class TestRoutesController {
  // ---- no policy declared on purpose: the guard must refuse it ----
  @Get("no-policy")
  noPolicy() {
    return { reached: true };
  }

  @Public()
  @Get("slow/:ms")
  async slow(@Param("ms") ms: string) {
    await sleep(Number(ms));
    return { done: true };
  }

  @Public()
  @Get("boom")
  boom(): never {
    throw new Error("secret-detail SELECT * FROM users WHERE password='hunter2' postgres://u:pw@db/x");
  }

  // ---- tenancy ----
  @Permission(ApiPermission.BUSINESS_READ)
  @Get("tenant-probe")
  async probe(@Tx() tx: TenantTx) {
    const setting = await tx.sql.query<{ t: string }>("select current_setting('app.tenant_id', true) as t");
    const visible = await tx.sql.query<{ n: string }>("select count(*)::text as n from tenants");
    return { setting: setting.rows[0]?.t, ctxTenant: tx.ctx.tenantId, visibleTenants: Number(visible.rows[0]?.n) };
  }

  @Permission(ApiPermission.CUSTOMERS_WRITE)
  @Post("commit")
  async commit(@Body() body: { name: string }, @Tx() tx: TenantTx) {
    return { id: await insertCustomer(tx.sql, tx.tenantId, body.name) };
  }

  @Permission(ApiPermission.CUSTOMERS_WRITE)
  @Post("rollback")
  async rollback(@Body() body: { name: string }, @Tx() tx: TenantTx) {
    await insertCustomer(tx.sql, tx.tenantId, body.name);
    throw new AppError(ErrorCode.CONFLICT, "nope");
  }

  /** GET runs in a READ ONLY transaction: this must fail and write nothing. */
  @Permission(ApiPermission.CUSTOMERS_READ)
  @Get("read-write")
  async readWrite(@Tx() tx: TenantTx) {
    await insertCustomer(tx.sql, tx.tenantId, "should-not-exist");
    return { wrote: true };
  }

  // ---- idempotency ----
  @Permission(ApiPermission.CUSTOMERS_WRITE)
  @Idempotent()
  @Post("idem")
  async idem(@Body() body: { name: string; delayMs?: number }, @Tx() tx: TenantTx) {
    counters.idem += 1;
    if (body.delayMs) await sleep(body.delayMs);
    const id = await insertCustomer(tx.sql, tx.tenantId, body.name);
    return { id, name: body.name, key: tx.ctx.idempotencyKey };
  }

  @Permission(ApiPermission.CUSTOMERS_WRITE)
  @Idempotent()
  @Post("idem/other")
  async idemOther(@Body() body: { name: string }, @Tx() tx: TenantTx) {
    return { id: await insertCustomer(tx.sql, tx.tenantId, body.name) };
  }

  /** Writes a row, then fails with the error named in the body. */
  @Permission(ApiPermission.CUSTOMERS_WRITE)
  @Idempotent()
  @HttpCode(201)
  @Post("idem/fail")
  async idemFail(@Body() body: { mode: "slot" | "validation" | "internal" | "flaky" }, @Tx() tx: TenantTx) {
    counters.idem += 1;
    await insertCustomer(tx.sql, tx.tenantId, `fail-${body.mode}`);
    if (body.mode === "slot") throw new AppError(ErrorCode.BOOKING_SLOT_TAKEN);
    if (body.mode === "validation") throw new AppError(ErrorCode.VALIDATION_FAILED);
    if (body.mode === "flaky") {
      counters.flaky += 1;
      if (counters.flaky === 1) throw new Error("transient failure");
      return { ok: true, attempt: counters.flaky };
    }
    throw new Error("boom");
  }

  // ---- real Postgres errors, reached through the real driver ----
  @Permission(ApiPermission.CUSTOMERS_WRITE)
  @Post("pg/:kind")
  async pg(@Param("kind") kind: string, @Tx() tx: TenantTx) {
    const t = tx.tenantId;
    const sql = tx.sql;
    switch (kind) {
      case "check": // 23514
        await sql.query(
          "insert into users (tenant_id, auth_provider, external_subject, name, role) values ($1, 'dev', 'dev|x-check', 'X', 'NOT_A_ROLE')",
          [t],
        );
        break;
      case "unique": // 23505
        for (let i = 0; i < 2; i++) {
          await sql.query("insert into users (tenant_id, auth_provider, external_subject, name, role) values ($1, 'dev', 'dev|dup', 'X', 'STAFF')", [t]);
        }
        break;
      case "uuid": // 22P02
        await sql.query("select 'not-a-uuid'::uuid");
        break;
      case "overlap": {
        // 23P01: two bookings on one resource at the same time
        const loc = (await sql.query<{ id: string }>("insert into locations (tenant_id, name) values ($1, 'L') returning id", [t])).rows[0]?.id;
        const res = (await sql.query<{ id: string }>("insert into resources (tenant_id, location_id, type, name) values ($1, $2, 'staff', 'R') returning id", [t, loc])).rows[0]?.id;
        const cust = await insertCustomer(sql, t, "overlap");
        const start = new Date(Date.now() + 86_400_000);
        const end = new Date(start.getTime() + 3_600_000);
        for (let i = 0; i < 2; i++) {
          const b = (
            await sql.query<{ id: string }>(
              "insert into bookings (tenant_id, location_id, customer_id, status, source_channel, starts_at, ends_at) values ($1,$2,$3,'CONFIRMED','api',$4,$5) returning id",
              [t, loc, cust, start, end],
            )
          ).rows[0]?.id;
          await sql.query("insert into booking_allocations (tenant_id, booking_id, resource_id, period) values ($1,$2,$3,$4::tstzrange)", [
            t,
            b,
            res,
            `[${start.toISOString()},${end.toISOString()})`,
          ]);
        }
        break;
      }
      case "fk": // 23503
        await sql.query("insert into user_locations (tenant_id, user_id, location_id) values ($1, gen_random_uuid(), gen_random_uuid())", [t]);
        break;
      case "audit": // 55000: append-only
        await sql.query("update audit_log set action = 'x'");
        break;
      default:
        break;
    }
    return { ok: true };
  }
}
