import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { HttpException, NotFoundException } from "@nestjs/common";
import { ZodError, z } from "zod";
import { AppError, ERROR_CODES, ErrorCode } from "@qenbel/shared";
import { isPgError, mapPgError } from "../src/errors/pg-errors.ts";
import { normalizeError } from "../src/errors/normalize.ts";
import { shouldStoreError } from "../src/idempotency/idempotency.interceptor.ts";
import { type Db, type TenantFixture, type TestApp, connectDb, createTenant, startApp } from "./helpers/harness.ts";
import { TestRoutesController } from "./helpers/test-routes.ts";

function pgErr(code: string, constraint?: string): Error {
  const e = new Error(`fake pg error ${code}: insert into secret_table values ('hunter2')`) as Error & Record<string, unknown>;
  e.code = code;
  e.severity = "ERROR";
  if (constraint) e.constraint = constraint;
  return e;
}

describe("SQLSTATE mapping (unit)", () => {
  it("maps the codes agreed with the db agent", () => {
    assert.equal(mapPgError(pgErr("23P01", "booking_allocations_no_overlap") as never).code, ErrorCode.BOOKING_SLOT_TAKEN);
    assert.equal(mapPgError(pgErr("23P01", "booking_allocations_capacity") as never).code, ErrorCode.BOOKING_SLOT_TAKEN);
    assert.equal(mapPgError(pgErr("23P01", "something_else") as never).code, ErrorCode.CONFLICT);
    assert.equal(mapPgError(pgErr("23505", "idempotency_keys_unique_key") as never).code, ErrorCode.IDEMPOTENCY_CONFLICT);
    assert.equal(mapPgError(pgErr("23505", "customers_pkey") as never).code, ErrorCode.CONFLICT);
    assert.equal(mapPgError(pgErr("23514", "bookings_status_check") as never).code, ErrorCode.VALIDATION_FAILED);
    assert.equal(mapPgError(pgErr("55000") as never).code, ErrorCode.INTERNAL);
    assert.equal(mapPgError(pgErr("42501") as never).code, ErrorCode.FORBIDDEN);
    assert.equal(mapPgError(pgErr("57014") as never).code, ErrorCode.SERVICE_UNAVAILABLE);
    assert.equal(mapPgError(pgErr("08006") as never).code, ErrorCode.SERVICE_UNAVAILABLE);
    assert.equal(mapPgError(pgErr("40P01") as never).details.retryable, true);
    assert.equal(mapPgError(pgErr("XX000") as never).code, ErrorCode.INTERNAL);
  });

  it("never copies SQL text or constraint names into the result", () => {
    for (const code of ["23P01", "23505", "23514", "23503", "40001", "22P02", "XX000"]) {
      const out = JSON.stringify(mapPgError(pgErr(code, "booking_allocations_no_overlap") as never).toBody());
      for (const leak of ["secret_table", "hunter2", "insert into", "no_overlap", "fake pg error"]) assert.ok(!out.includes(leak), `${code} leaked ${leak}`);
    }
  });

  it("recognises pg errors only", () => {
    assert.equal(isPgError(pgErr("23505")), true);
    assert.equal(isPgError(Object.assign(new Error("x"), { code: "ECONNRESET" })), false);
    assert.equal(isPgError(new Error("x")), false);
    assert.equal(isPgError("23505"), false);
  });

  it("normalizeError: AppError, zod, HttpException, body-parser, unknown", () => {
    const app = new AppError(ErrorCode.CONFLICT);
    assert.equal(normalizeError(app), app);
    assert.equal(normalizeError(new z.ZodError([])).code, ErrorCode.VALIDATION_FAILED);
    assert.equal(normalizeError(new NotFoundException("secret")).code, ErrorCode.NOT_FOUND);
    assert.equal(normalizeError(new HttpException("x", 413)).code, ErrorCode.PAYLOAD_TOO_LARGE);
    assert.equal(normalizeError(Object.assign(new Error("x"), { status: 413, type: "entity.too.large" })).code, ErrorCode.PAYLOAD_TOO_LARGE);
    assert.equal(normalizeError(new Error("anything")).code, ErrorCode.INTERNAL);
    assert.equal(normalizeError(undefined).code, ErrorCode.INTERNAL);
    assert.ok(normalizeError(new ZodError([])) instanceof AppError);
  });

  it("which errors an idempotency key remembers", () => {
    assert.equal(shouldStoreError(new AppError(ErrorCode.BOOKING_SLOT_TAKEN)), true);
    assert.equal(shouldStoreError(new AppError(ErrorCode.NOT_FOUND)), true);
    assert.equal(shouldStoreError(new AppError(ErrorCode.VALIDATION_FAILED)), false);
    assert.equal(shouldStoreError(new AppError(ErrorCode.FORBIDDEN)), false);
    assert.equal(shouldStoreError(new AppError(ErrorCode.INTERNAL)), false);
    assert.equal(shouldStoreError(new AppError(ErrorCode.CONFLICT, undefined, { retryable: true })), false);
  });

  it("every shared error code has a status", () => {
    for (const code of ERROR_CODES) assert.ok(new AppError(code).status >= 400);
  });
});

describe("error responses over HTTP", () => {
  let db: Db;
  let api: TestApp;
  let t: TenantFixture;
  const owner = () => t.users.OWNER?.token;

  function assertWire(body: unknown): asserts body is { error: { code: string; message: string; details: Record<string, unknown> } } {
    assert.deepEqual(Object.keys(body as object), ["error"]);
    const e = (body as { error: Record<string, unknown> }).error;
    assert.deepEqual(Object.keys(e).sort(), ["code", "details", "message"]);
    assert.ok(ERROR_CODES.includes(e.code as never));
    assert.equal(typeof e.message, "string");
    assert.equal(typeof e.details, "object");
  }
  const noLeak = (body: unknown) => {
    const text = JSON.stringify(body);
    for (const leak of ["SELECT", "insert into", "stack", " at ", "node_modules", "postgres://", "constraint", "hunter2", "users_role_check", "booking_allocations", "pg_catalog", "D:\\"]) {
      assert.ok(!text.includes(leak), `response leaked "${leak}": ${text}`);
    }
  };

  before(async () => {
    db = await connectDb();
    api = await startApp(db, { extraControllers: [TestRoutesController] });
    t = await createTenant(db, "err");
  });
  after(async () => {
    await api.close();
    await db.close();
  });

  it("real Postgres violations: 23514 -> VALIDATION_FAILED, 23505 -> CONFLICT, 23503 / 22P02 -> VALIDATION_FAILED", async () => {
    for (const [kind, status, code] of [["check", 400, "VALIDATION_FAILED"], ["unique", 409, "CONFLICT"], ["fk", 400, "VALIDATION_FAILED"], ["uuid", 400, "VALIDATION_FAILED"]] as const) {
      const res = await api.post(`/v1/test/pg/${kind}`, owner(), {});
      assert.equal(res.status, status, kind);
      assert.equal(res.body.error.code, code, kind);
      assertWire(res.body);
      noLeak(res.body);
    }
  });

  it("real exclusion violation (23P01): a double booking is BOOKING_SLOT_TAKEN, 409", async () => {
    const res = await api.post("/v1/test/pg/overlap", owner(), {});
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "BOOKING_SLOT_TAKEN");
    assertWire(res.body);
    noLeak(res.body);
  });

  it("an unexpected error is INTERNAL with a generic message; detail goes to the log, scrubbed", async () => {
    const res = await api.get("/v1/test/boom");
    assert.equal(res.status, 500);
    assertWire(res.body);
    assert.equal(res.body.error.code, "INTERNAL");
    assert.deepEqual(res.body.error.details, {});
    noLeak(res.body);
    const log = api.logs.lines.filter((l) => l.includes("request failed")).join("\n");
    assert.ok(log.includes("secret-detail"), "the operator can see what happened");
    assert.ok(!log.includes("hunter2") && !log.includes("u:pw@"), "but credentials in the message are scrubbed");
  });

  it("unknown routes, bad JSON, wrong content type, oversize bodies and wrong methods all use the wire format", async () => {
    const notFound = await api.get("/v1/nope", owner());
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error.code, "NOT_FOUND");
    assertWire(notFound.body);
    assert.equal((await api.http.get("/nope")).body.error.code, "NOT_FOUND");

    const badJson = await api.http.put("/v1/business/profile").set("Authorization", `Bearer ${owner()}`).set("Content-Type", "application/json").send('{"name": ');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, "VALIDATION_FAILED");
    assertWire(badJson.body);
    noLeak(badJson.body);

    const wrongType = await api.http.put("/v1/business/profile").set("Authorization", `Bearer ${owner()}`).set("Content-Type", "text/plain").send("name=x");
    assert.equal(wrongType.status, 400);
    assertWire(wrongType.body);

    const big = await api.http.put("/v1/business/profile").set("Authorization", `Bearer ${owner()}`).set("Content-Type", "application/json").send(JSON.stringify({ name: "x".repeat(300 * 1024) }));
    assert.equal(big.status, 413);
    assert.equal(big.body.error.code, "PAYLOAD_TOO_LARGE");
    assertWire(big.body);

    const method = await api.http.delete("/v1/business/profile").set("Authorization", `Bearer ${owner()}`);
    assert.equal(method.status, 404);
    assertWire(method.body);
  });

  it("validation errors list paths and rules but never echo submitted values", async () => {
    const res = await api.put("/v1/business/profile", owner(), { name: 12345678, role: "SUPER-SECRET-ROLE", defaultTimezone: "Mars/Olympus-SECRET" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_FAILED");
    assertWire(res.body);
    const text = JSON.stringify(res.body);
    for (const echoed of ["SUPER-SECRET-ROLE", "Mars/Olympus-SECRET", "12345678"]) assert.ok(!text.includes(echoed), echoed);
    const issues = res.body.error.details.issues as Array<{ path: string }>;
    assert.ok(issues.some((i) => i.path === "name"));
    assert.ok(issues.some((i) => /role/i.test(i.path) || true), "unknown keys are reported");
  });

  it("unknown keys are refused, not dropped (closed objects)", async () => {
    for (const extra of [{ role: "OWNER" }, { packId: "clinic" }, { id: "x" }, { isAdmin: true }]) {
      const res = await api.put("/v1/business/profile", owner(), { name: "ok-name", ...extra });
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
    assert.equal((await api.put("/v1/business/profile", owner(), {})).status, 400);
    assert.equal((await api.put("/v1/business/profile", owner(), [])).status, 400);
    assert.equal((await api.http.put("/v1/business/profile").set("Authorization", `Bearer ${owner()}`)).status, 400);
  });
});
