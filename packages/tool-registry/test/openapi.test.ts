import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listTools, toolsForPack, toOpenApi, SAMPLE_OPENAPI_OPTIONS, TOOL_ERROR_CATALOGUE } from "../src/index.ts";
import { checkOpenApi31, forbiddenKeysIn } from "./helpers.ts";
import type { Node } from "./helpers.ts";

const opts = { title: "Test API", version: "0.0.1", serverUrl: "https://api.example.test" };
const doc = () => toOpenApi(listTools(), opts) as unknown as Node;

test("generated OpenAPI 3.1 document passes the structural checks", () => {
  assert.deepEqual(checkOpenApi31(doc()), []);
});

test("the checker catches a broken document (dangling ref, wrong version, missing bearer scheme)", () => {
  const broken = structuredClone(doc()) as Node;
  broken["openapi"] = "3.0.3";
  assert.ok(checkOpenApi31(broken).some((p) => p.includes("3.1")));

  const dangling = structuredClone(doc()) as unknown as { paths: Record<string, { post: { requestBody: { content: Record<string, { schema: { $ref: string } }> } } }> };
  dangling.paths["/v1/tools/get_catalogue"]!.post.requestBody.content["application/json"]!.schema.$ref = "#/components/schemas/Nope";
  assert.ok(checkOpenApi31(dangling).some((p) => p.includes("dangling")));

  const noScheme = structuredClone(doc()) as { components: { securitySchemes: object } };
  noScheme.components.securitySchemes = {};
  assert.ok(checkOpenApi31(noScheme).some((p) => p.includes("bearerAuth")));
});

test("info, server and the document survive a JSON round trip unchanged", () => {
  const d = doc();
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
  assert.equal(d["openapi"], "3.1.0");
  assert.deepEqual((d["info"] as Node)["title"], "Test API");
  assert.deepEqual(d["servers"], [{ url: "https://api.example.test" }]);
});

test("one POST /v1/tools/{name} operation per tool, nothing else", () => {
  const d = doc() as { paths: Record<string, Record<string, Node>> };
  const paths = Object.keys(d.paths);
  assert.deepEqual(paths, listTools().map((t) => `/v1/tools/${t.name}`));
  for (const tool of listTools()) {
    const item = d.paths[`/v1/tools/${tool.name}`]!;
    assert.deepEqual(Object.keys(item), ["post"]);
    assert.equal(item["post"]!["operationId"], tool.name);
  }
});

test("Idempotency-Key header is required on write tools and absent on read tools", () => {
  const d = doc() as unknown as { paths: Record<string, { post: { parameters?: { $ref: string }[] } }>; components: { parameters: Record<string, Node> } };
  const param = d.components.parameters["IdempotencyKey"]!;
  assert.equal(param["name"], "Idempotency-Key");
  assert.equal(param["in"], "header");
  assert.equal(param["required"], true);
  for (const tool of listTools()) {
    const params = d.paths[`/v1/tools/${tool.name}`]!.post.parameters ?? [];
    const has = params.some((p) => p.$ref === "#/components/parameters/IdempotencyKey");
    assert.equal(has, tool.requiresIdempotencyKey, tool.name);
  }
});

test("bearer API key security scheme is global and the Error shape is { error: { code, message, details } }", () => {
  const d = doc() as unknown as { security: object[]; components: { securitySchemes: Record<string, Node>; schemas: Record<string, Node> } };
  assert.deepEqual(d.security, [{ bearerAuth: [] }]);
  assert.equal(d.components.securitySchemes["bearerAuth"]!["scheme"], "bearer");
  const err = d.components.schemas["Error"] as { required: string[]; properties: { error: { required: string[]; properties: Node } } };
  assert.deepEqual(err.required, ["error"]);
  assert.deepEqual(err.properties.error.required, ["code", "message", "details"]);
});

test("request schemas never include a tenant, organisation or role", () => {
  const d = doc() as unknown as { components: { schemas: Record<string, unknown> } };
  assert.deepEqual(forbiddenKeysIn(d.components.schemas), []);
  assert.doesNotMatch(JSON.stringify(Object.keys(d.components.schemas)), /tenant/i);
  assert.doesNotMatch(JSON.stringify((d as Node)["paths"]).replace(/x-qenbel-[a-z-]+/g, ""), /"in":"(query|path)"/);
});

test("every operation documents its own error codes under the right HTTP status", () => {
  const d = doc() as unknown as { paths: Record<string, { post: { responses: Record<string, { description: string }>; "x-qenbel-errors": { code: string; httpStatus: number }[] } }> };
  for (const tool of listTools()) {
    const op = d.paths[`/v1/tools/${tool.name}`]!.post;
    for (const code of tool.errorCodes) {
      const status = String(TOOL_ERROR_CATALOGUE[code].httpStatus);
      assert.ok(op.responses[status]?.description.includes(code), `${tool.name}: ${code} missing under ${status}`);
    }
    assert.ok(op.responses["400"] && op.responses["401"] && op.responses["403"] && op.responses["429"] && op.responses["500"], tool.name);
    assert.equal(tool.requiresIdempotencyKey, op.responses["400"]!.description.includes("IDEMPOTENCY_KEY_REQUIRED"), tool.name);
    for (const e of op["x-qenbel-errors"]) assert.equal(e.httpStatus, TOOL_ERROR_CATALOGUE[e.code as keyof typeof TOOL_ERROR_CATALOGUE].httpStatus);
  }
});

test("429 responses carry Retry-After and rate limit headers", () => {
  const d = doc() as unknown as { paths: Record<string, { post: { responses: Record<string, { headers?: Record<string, unknown> }> } }> };
  const headers = d.paths["/v1/tools/check_availability"]!.post.responses["429"]!.headers!;
  assert.ok("Retry-After" in headers && "RateLimit-Remaining" in headers);
});

test("tool descriptions and metadata are copied into the operation", () => {
  const d = doc() as unknown as { paths: Record<string, { post: Node }> };
  for (const tool of listTools()) {
    const op = d.paths[`/v1/tools/${tool.name}`]!.post;
    assert.equal(op["description"], tool.description);
    assert.equal(op["x-qenbel-permission-level"], tool.permissionLevel);
    assert.equal(op["x-qenbel-required-permission"], tool.requiredPermission);
    assert.equal(op["x-qenbel-requires-idempotency-key"], tool.requiresIdempotencyKey);
  }
});

test("a pack subset produces a smaller, still valid document", () => {
  const subset = toolsForPack(["get_catalogue", "check_availability"]);
  const d = toOpenApi(subset, opts);
  assert.deepEqual(Object.keys(d.paths), ["/v1/tools/get_catalogue", "/v1/tools/check_availability"]);
  assert.deepEqual(checkOpenApi31(d), []);
});

test("the committed sample docs/generated/tools.openapi.json is up to date", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../../docs/generated/tools.openapi.json");
  const committed = JSON.parse(readFileSync(file, "utf8"));
  const fresh = JSON.parse(JSON.stringify(toOpenApi(listTools(), SAMPLE_OPENAPI_OPTIONS)));
  assert.deepEqual(committed, fresh, "run: npm run generate -w @qenbel/tool-registry");
  assert.deepEqual(checkOpenApi31(committed), []);
});
