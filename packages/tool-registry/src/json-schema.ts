import { z } from "zod";
import type { AnyToolDefinition } from "./types.ts";

export type JsonSchema = { [key: string]: unknown };

export interface ToolJsonSchemas {
  input: JsonSchema;
  output: JsonSchema;
}

// zod emits a long regular expression next to these formats. The format already says what is
// meant, and the server validates with zod anyway, so the pattern is dropped to keep the schema
// small enough for a model to read.
const FORMATS_WITHOUT_PATTERN = new Set(["uuid", "date-time", "date", "email"]);

function clean(node: unknown, dropAdditionalFalse: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => clean(n, dropAdditionalFalse));
  if (node === null || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === "$schema") continue;
    if (key === "pattern" && typeof src["format"] === "string" && FORMATS_WITHOUT_PATTERN.has(src["format"])) continue;
    if (key === "additionalProperties" && value === false && dropAdditionalFalse) continue;
    out[key] = clean(value, dropAdditionalFalse);
  }
  return out;
}

/** JSON Schema (draft 2020-12, also valid inside OpenAPI 3.1) for what the caller sends. */
export function toInputJsonSchema(tool: AnyToolDefinition): JsonSchema {
  return clean(z.toJSONSchema(tool.input, { target: "draft-2020-12", io: "input", unrepresentable: "throw" }), false) as JsonSchema;
}

/**
 * JSON Schema for what the tool returns. `additionalProperties: false` is left out so a client
 * that validates responses keeps working when a field is added.
 */
export function toOutputJsonSchema(tool: AnyToolDefinition): JsonSchema {
  return clean(z.toJSONSchema(tool.output, { target: "draft-2020-12", io: "output", unrepresentable: "throw" }), true) as JsonSchema;
}

export function toJsonSchema(tool: AnyToolDefinition): ToolJsonSchemas {
  return { input: toInputJsonSchema(tool), output: toOutputJsonSchema(tool) };
}
