import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools, toOutputJsonSchema } from "../src/index.ts";
import { collectPropertyNames } from "./helpers.ts";

test("every example input and output validates against the tool's own schemas", () => {
  for (const tool of listTools()) {
    for (const ex of tool.examples) {
      const i = tool.input.safeParse(ex.input);
      assert.equal(i.success, true, `${tool.name} / ${ex.title} input: ${i.success ? "" : i.error.message}`);
      const o = tool.output.safeParse(ex.output);
      assert.equal(o.success, true, `${tool.name} / ${ex.title} output: ${o.success ? "" : o.error.message}`);
    }
  }
});

test("example titles are unique per tool and plain", () => {
  for (const tool of listTools()) {
    const titles = tool.examples.map((e) => e.title);
    assert.equal(new Set(titles).size, titles.length, tool.name);
    for (const t of titles) assert.ok(t.length > 3 && t.length < 60, `${tool.name}: ${t}`);
  }
});

test("examples carry no tenant ids and no secrets", () => {
  for (const tool of listTools()) {
    const text = JSON.stringify(tool.examples);
    assert.doesNotMatch(text, /tenant|secret|password|api[_-]?key|bearer/i, tool.name);
  }
});

test("booking and order tools return the expected status in their examples", () => {
  const expected: Record<string, string> = {
    create_booking_hold: "HOLD",
    confirm_booking: "CONFIRMED",
    reschedule_booking: "CONFIRMED",
    cancel_booking: "CANCELLED",
    create_order_draft: "DRAFT",
    confirm_order: "PLACED",
    cancel_order: "CANCELLED",
  };
  for (const tool of listTools()) {
    const want = expected[tool.name];
    if (!want) continue;
    for (const ex of tool.examples) assert.equal((ex.output as { status: string }).status, want, tool.name);
  }
});

test("a wrong status in an output is rejected (the engines, not the model, own state)", () => {
  const confirm = listTools().find((t) => t.name === "confirm_booking")!;
  const out = { ...(confirm.examples[0]!.output as object), status: "HOLD" };
  assert.equal(confirm.output.safeParse(out).success, false);
});

test("search_customer output declares masked contact fields only", () => {
  const tool = listTools().find((t) => t.name === "search_customer")!;
  const names = collectPropertyNames(toOutputJsonSchema(tool));
  assert.ok(names.includes("phoneMasked") && names.includes("emailMasked"));
  assert.ok(!names.includes("phone") && !names.includes("email"));
});
