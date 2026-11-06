import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools, toMcpTools, toProviderFunctionSchemas, toInputJsonSchema, toolsForPack } from "../src/index.ts";
import { forbiddenKeysIn } from "./helpers.ts";

test("MCP descriptors: name, description, object inputSchema, hints", () => {
  const mcp = toMcpTools(listTools());
  assert.equal(mcp.length, 13);
  for (const [i, d] of mcp.entries()) {
    const tool = listTools()[i]!;
    assert.equal(d.name, tool.name);
    assert.equal(d.description, tool.description);
    assert.equal(d.inputSchema.type, "object");
    assert.deepEqual(d.inputSchema, toInputJsonSchema(tool));
    assert.equal(d.annotations.readOnlyHint, tool.permissionLevel === "READ");
    assert.deepEqual(forbiddenKeysIn(d.inputSchema), []);
  }
  assert.equal(mcp.find((d) => d.name === "cancel_booking")!.annotations.destructiveHint, true);
  assert.equal(mcp.find((d) => d.name === "check_availability")!.annotations.destructiveHint, false);
});

test("MCP descriptors are plain JSON", () => {
  const mcp = toMcpTools(listTools());
  assert.deepEqual(JSON.parse(JSON.stringify(mcp)), mcp);
});

test("provider function schemas: name, description, parameters", () => {
  const fns = toProviderFunctionSchemas(listTools());
  assert.equal(fns.length, 13);
  for (const f of fns) {
    assert.deepEqual(Object.keys(f).sort(), ["description", "name", "parameters"]);
    assert.equal(f.parameters["type"], "object");
    assert.equal(f.parameters["additionalProperties"], false);
    assert.equal(f.parameters["$schema"], undefined);
  }
});

test("adapters accept a pack subset and keep its order", () => {
  const subset = toolsForPack(["escalate_to_human", "get_business_profile"]);
  assert.deepEqual(toMcpTools(subset).map((d) => d.name), ["get_business_profile", "escalate_to_human"]);
  assert.deepEqual(toProviderFunctionSchemas(subset).map((d) => d.name), ["get_business_profile", "escalate_to_human"]);
  assert.deepEqual(toMcpTools([]), []);
});

test("a property description reaches the model schema", () => {
  const avail = toProviderFunctionSchemas(toolsForPack(["check_availability"]))[0]!;
  const props = avail.parameters["properties"] as Record<string, { description?: string }>;
  assert.match(props["fromDate"]!.description!, /YYYY-MM-DD/);
});
