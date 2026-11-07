import { test } from "node:test";
import assert from "node:assert/strict";
import { maskEmail, maskPhone, normaliseEmail, normalisePhone } from "../src/index.ts";

const E164 = /^\+[1-9][0-9]{6,14}$/;

test("normalisePhone: Indian mobile numbers in common spellings all give the same E.164", () => {
  const spellings = [
    "9876543210", "09876543210", "919876543210", "+919876543210", "+91 98765 43210", "+91-98765-43210",
    "(+91) 98765 43210", "98765 43210", "98765.43210", "0091 98765 43210", "  +91 9876543210  ", "+91 (98765) 43210",
  ];
  for (const s of spellings) assert.equal(normalisePhone(s), "+919876543210", `spelling: ${s}`);
});

test("normalisePhone: explicit international numbers keep their country", () => {
  assert.equal(normalisePhone("+1 (202) 555-0123"), "+12025550123");
  assert.equal(normalisePhone("+44 7911 123456"), "+447911123456");
  assert.equal(normalisePhone("0044 7911 123456"), "+447911123456");
  assert.equal(normalisePhone("+971 50 123 4567"), "+971501234567");
});

test("normalisePhone: results always satisfy the database CHECK (E.164)", () => {
  for (const s of ["9876543210", "+442071838750", "+14155552671", "+919876543210"]) {
    assert.match(normalisePhone(s) as string, E164);
  }
});

test("normalisePhone: refuses what it cannot normalise safely", () => {
  const bad: unknown[] = [
    "", "   ", "abc", "98765", "98765432", "12345678901", // bare 11 digits: could be anything
    "5876543210", // Indian mobiles start 6-9
    "+91 5876543210".replace("5", "0"), // national part starts with 0
    "+91987654321", // 9 digits after +91
    "+9198765432101", // 11 digits after +91
    "+0123456789", "+1", "+1234567890123456", // too long for E.164 (16 digits)
    "9876543210 ext 12", "9876543210x12", "tel:9876543210", "+91 98765 43210 +", "98+76543210",
    "٩٨٧٦٥٤٣٢١٠", // non-ASCII digits
    null, undefined, 9876543210, {}, [],
  ];
  for (const s of bad) assert.equal(normalisePhone(s), null, `should refuse: ${String(s)}`);
});

test("normalisePhone: another default country code is honoured, trunk 0 is dropped", () => {
  assert.equal(normalisePhone("07911 123456", { defaultCallingCode: "44" }), "+447911123456");
  assert.equal(normalisePhone("7911123456", { defaultCallingCode: "44" }), "+447911123456");
  assert.equal(normalisePhone("+919876543210", { defaultCallingCode: "44" }), "+919876543210");
  assert.equal(normalisePhone("123", { defaultCallingCode: "44" }), null);
  assert.equal(normalisePhone("9876543210", { defaultCallingCode: "abc" }), null);
});

test("normalisePhone is idempotent", () => {
  for (const s of ["9876543210", "+1 202 555 0123", "0044 7911 123456"]) {
    const once = normalisePhone(s) as string;
    assert.equal(normalisePhone(once), once);
  }
});

test("normaliseEmail", () => {
  assert.equal(normaliseEmail("  Jane.Doe@Example.COM "), "jane.doe@example.com");
  assert.equal(normaliseEmail("a+tag@sub.example.co.in"), "a+tag@sub.example.co.in");
  for (const bad of ["", "no-at-sign", "a@b", "a b@example.com", "@example.com", "a@@example.com", "<a>@example.com", `${"x".repeat(250)}@example.com`, null, 5]) {
    assert.equal(normaliseEmail(bad), null, `should refuse: ${String(bad)}`);
  }
});

test("masks never contain the full value", () => {
  assert.equal(maskPhone("+919876543210"), "******3210");
  assert.equal(maskPhone(null), null);
  assert.equal(maskEmail("jane.doe@example.com"), "j***@example.com");
  assert.equal(maskEmail("x"), "***");
  assert.equal(maskEmail(null), null);
  assert.ok(!(maskPhone("+919876543210") as string).includes("98765"));
  assert.ok(!(maskEmail("jane.doe@example.com") as string).includes("jane"));
});
