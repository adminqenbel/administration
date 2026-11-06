import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolName } from "@qenbel/shared";
import { listTools, toInputJsonSchema, toOutputJsonSchema, toJsonSchema } from "../src/index.ts";
import { forbiddenKeysIn, walkSchema, normaliseKey, stringLeafPaths, setAtPath } from "./helpers.ts";
import type { Node } from "./helpers.ts";

test("walker self-check: finds tenant ids at any depth and in any spelling", () => {
  const bad = { type: "object", properties: { a: { type: "array", items: { type: "object", properties: { tenant_id: { type: "string" } } } } } };
  assert.deepEqual(forbiddenKeysIn(bad), ["tenant_id"]);
  for (const k of ["tenantId", "TENANT_ID", "tenant-id", "organisationId", "organizationId", "org_id", "role"]) {
    assert.deepEqual(forbiddenKeysIn({ properties: { [k]: {} } }), [k], k);
  }
  assert.equal(normaliseKey("Tenant_Id"), "tenantid");
});

test("no tool input or output has a tenant, organisation, role or idempotency-key field", () => {
  for (const tool of listTools()) {
    assert.deepEqual(forbiddenKeysIn(toInputJsonSchema(tool)), [], `${tool.name} input`);
    assert.deepEqual(forbiddenKeysIn(toOutputJsonSchema(tool)), [], `${tool.name} output`);
  }
});

test("tools reject tenantId and similar keys sent by the caller", () => {
  for (const tool of listTools()) {
    const base = tool.examples[0]!.input;
    assert.equal(tool.input.safeParse(base).success, true, `${tool.name}: example must be valid`);
    for (const key of ["tenantId", "tenant_id", "organisationId", "orgId", "role", "idempotencyKey"]) {
      const result = tool.input.safeParse({ ...(base as object), [key]: "00000000-0000-4000-8000-000000000000" });
      assert.equal(result.success, false, `${tool.name} accepted ${key}`);
    }
  }
});

test("tool names are specific: no generic names", () => {
  const banned = /(execute|sql|query|raw|any|generic|perform|action|update_record|run_|do_|admin|anything)/;
  for (const tool of listTools()) {
    assert.match(tool.name, /^[a-z]+(_[a-z]+)+$/, tool.name);
    assert.doesNotMatch(tool.name, banned, tool.name);
  }
  for (const generic of ["execute_sql", "update_any_record", "perform_business_action"]) {
    assert.ok(!listTools().some((t) => t.name === generic));
    assert.ok(!Object.values(ToolName).includes(generic as never));
  }
});

test("every input string, array and number is bounded; every object is closed", () => {
  for (const tool of listTools()) {
    walkSchema(toInputJsonSchema(tool), (n: Node, path) => {
      const where = `${tool.name} ${path}`;
      const type = n["type"];
      if (type === "string" && n["enum"] === undefined && n["const"] === undefined) {
        assert.equal(typeof n["maxLength"], "number", `${where}: string without maxLength`);
        assert.ok((n["maxLength"] as number) <= 1000, `${where}: maxLength too large`);
      }
      if (type === "array") assert.equal(typeof n["maxItems"], "number", `${where}: array without maxItems`);
      if (type === "integer" || type === "number") {
        assert.equal(typeof n["minimum"], "number", `${where}: number without minimum`);
        assert.equal(typeof n["maximum"], "number", `${where}: number without maximum`);
      }
      if (type === "object") assert.equal(n["additionalProperties"], false, `${where}: object must set additionalProperties false`);
    });
  }
});

test("input schemas are always objects at the top level", () => {
  for (const tool of listTools()) assert.equal(toInputJsonSchema(tool)["type"], "object", tool.name);
});

test("an over-long value in any string field is rejected", () => {
  for (const tool of listTools()) {
    const base = tool.examples[0]!.input;
    for (const path of stringLeafPaths(base)) {
      const mutated = setAtPath(base, path, "x".repeat(5000));
      assert.equal(tool.input.safeParse(mutated).success, false, `${tool.name} accepted a 5000 character value at ${path.join(".")}`);
    }
  }
});

test("text fields trim and reject control characters", () => {
  const confirm = listTools().find((t) => t.name === "confirm_booking")!;
  const base = confirm.examples[0]!.input as { customer: { name: string } };
  const ctrl = { ...base, customer: { ...base.customer, name: "Asha\u0000" } };
  assert.equal(confirm.input.safeParse(ctrl).success, false);
});

test("array sizes are capped (order items, answers)", () => {
  const draft = listTools().find((t) => t.name === "create_order_draft")!;
  const item = { catalogueItemId: "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b", quantity: 1 };
  assert.equal(draft.input.safeParse({ items: [] }).success, false);
  assert.equal(draft.input.safeParse({ items: Array.from({ length: 51 }, () => item) }).success, false);
  assert.equal(draft.input.safeParse({ items: Array.from({ length: 50 }, () => item) }).success, true);
  assert.equal(draft.input.safeParse({ items: [{ ...item, quantity: 100 }] }).success, false);
  assert.equal(draft.input.safeParse({ items: [{ ...item, quantity: 1.5 }] }).success, false);
});

test("money in outputs is integer paise, never a float field", () => {
  for (const tool of listTools()) {
    walkSchema(toOutputJsonSchema(tool), (n, path) => {
      const props = n["properties"];
      if (!props || typeof props !== "object") return;
      for (const [name, def] of Object.entries(props as Node)) {
        if (/amount|price|total/i.test(name)) {
          assert.match(name, /Paise$/, `${tool.name} ${path}: money field ${name} must end in Paise`);
          const d = def as Node;
          const t = d["type"] ?? ((d["anyOf"] as Node[] | undefined)?.find((x) => x["type"] !== "null")?.["type"]);
          assert.equal(t, "integer", `${tool.name} ${name} must be an integer`);
        }
      }
    });
  }
});

test("toJsonSchema returns input and output without $schema noise or long patterns", () => {
  for (const tool of listTools()) {
    const { input, output } = toJsonSchema(tool);
    assert.equal(input["$schema"], undefined);
    assert.equal(output["$schema"], undefined);
    const text = JSON.stringify(input);
    assert.ok(text.length < 6000, `${tool.name} input schema is ${text.length} bytes`);
  }
});
