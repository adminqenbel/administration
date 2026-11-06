import { toInputJsonSchema, toOutputJsonSchema } from "./json-schema.ts";
import type { JsonSchema } from "./json-schema.ts";
import type { AnyToolDefinition } from "./types.ts";

export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  /** Optional in the MCP spec. To confirm against the MCP revision a client targets. */
  outputSchema: JsonSchema;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

// Tools that replace or end something that already exists.
const CHANGES_EXISTING = new Set(["cancel_booking", "cancel_order", "reschedule_booking"]);

/**
 * MCP tool descriptors. The MCP server (Stage 5) supplies the tenant from its own credential and
 * derives an Idempotency-Key per call; neither is part of `inputSchema`.
 */
export function toMcpTools(tools: readonly AnyToolDefinition[]): McpToolDescriptor[] {
  return tools.map((tool) => {
    const inputSchema = toInputJsonSchema(tool);
    if (inputSchema["type"] !== "object") throw new Error(`Tool ${tool.name}: input must be an object`);
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: inputSchema as JsonSchema & { type: "object" },
      outputSchema: toOutputJsonSchema(tool),
      annotations: {
        readOnlyHint: tool.permissionLevel === "READ",
        destructiveHint: CHANGES_EXISTING.has(tool.name),
        idempotentHint: true,
        openWorldHint: false,
      },
    };
  });
}

export interface ProviderFunctionSchema {
  name: string;
  description: string;
  /** JSON Schema object. Anthropic calls this `input_schema`, OpenAI-style APIs call it `parameters`. */
  parameters: JsonSchema;
}

/** Generic function-calling shape. Adapters rename `parameters` for a specific provider. */
export function toProviderFunctionSchemas(tools: readonly AnyToolDefinition[]): ProviderFunctionSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toInputJsonSchema(tool),
  }));
}
