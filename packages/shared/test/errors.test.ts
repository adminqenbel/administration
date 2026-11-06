import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  AppError,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ErrorCode,
  errorBodySchema,
  errorStatus,
  isAppError,
  parseOrThrow,
  toErrorBody,
} from "../src/index.ts";

test("required codes exist", () => {
  for (const c of [
    "BOOKING_SLOT_TAKEN",
    "HOLD_EXPIRED",
    "INVALID_TRANSITION",
    "TOOL_NOT_ENABLED",
    "IDEMPOTENCY_CONFLICT",
    "TENANT_REQUIRED",
    "FORBIDDEN",
    "NOT_FOUND",
    "VALIDATION_FAILED",
    "RATE_LIMITED",
  ]) {
    assert.ok((ERROR_CODES as readonly string[]).includes(c), c);
  }
});

test("every code has an HTTP status and keys equal values", () => {
  for (const c of ERROR_CODES) {
    assert.equal(ErrorCode[c], c);
    const s = ERROR_HTTP_STATUS[c];
    assert.ok(Number.isInteger(s) && s >= 400 && s < 600, c);
  }
  assert.equal(ERROR_HTTP_STATUS.BOOKING_SLOT_TAKEN, 409);
  assert.equal(ERROR_HTTP_STATUS.FORBIDDEN, 403);
  assert.equal(ERROR_HTTP_STATUS.NOT_FOUND, 404);
});

test("wire format is { error: { code, message, details } }", () => {
  const err = new AppError(ErrorCode.BOOKING_SLOT_TAKEN, undefined, { resourceId: "r1" });
  const body = toErrorBody(err);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "details", "message"]);
  assert.equal(body.error.code, "BOOKING_SLOT_TAKEN");
  assert.deepEqual(body.error.details, { resourceId: "r1" });
  assert.ok(errorBodySchema.safeParse(JSON.parse(JSON.stringify(body))).success);
  assert.deepEqual(err.toBody(), body);
  assert.equal(err.status, 409);
});

test("details default to an empty object", () => {
  assert.deepEqual(new AppError(ErrorCode.NOT_FOUND).details, {});
  assert.equal(new AppError(ErrorCode.NOT_FOUND, "No such booking").message, "No such booking");
});

test("unknown errors become INTERNAL and leak nothing", () => {
  const body = toErrorBody(new Error("password=hunter2 at db"));
  assert.equal(body.error.code, "INTERNAL");
  assert.ok(!JSON.stringify(body).includes("hunter2"));
  assert.equal(errorStatus(new TypeError("x")), 500);
  assert.equal(errorStatus(new AppError(ErrorCode.RATE_LIMITED)), 429);
  assert.equal(isAppError(new Error("x")), false);
  assert.equal(isAppError({ code: "FORBIDDEN" }), false);
});

test("parseOrThrow gives VALIDATION_FAILED with paths and no input values", () => {
  const schema = z.object({ phone: z.string().min(10) }).strict();
  assert.throws(
    () => parseOrThrow(schema, { phone: "secret", extra: 1 }),
    (e: unknown) => {
      assert.ok(e instanceof AppError);
      assert.equal(e.code, "VALIDATION_FAILED");
      const issues = e.details.issues as { path: string }[];
      assert.ok(issues.length >= 1 && issues.every((i) => typeof i.path === "string"));
      assert.ok(!JSON.stringify(e.details).includes("secret"));
      return true;
    },
  );
  assert.deepEqual(parseOrThrow(schema, { phone: "1234567890" }), { phone: "1234567890" });
});
