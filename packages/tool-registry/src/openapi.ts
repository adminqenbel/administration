import { COMMON_ERROR_CODES, IDEMPOTENCY_ERROR_CODES, TOOL_ERROR_CATALOGUE } from "./errors.ts";
import type { ToolErrorCode } from "./errors.ts";
import { toInputJsonSchema, toOutputJsonSchema } from "./json-schema.ts";
import type { JsonSchema } from "./json-schema.ts";
import type { AnyToolDefinition } from "./types.ts";

export interface OpenApiOptions {
  title: string;
  version: string;
  serverUrl: string;
  description?: string;
}

export type OpenApiDocument = { [key: string]: unknown } & {
  openapi: "3.1.0";
  info: { title: string; version: string; description?: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: Record<string, unknown>;
    parameters: Record<string, unknown>;
    headers: Record<string, unknown>;
  };
  security: Record<string, string[]>[];
  tags: { name: string; description: string }[];
};

const pascal = (snake: string) =>
  snake
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const errorResponse = (description: string, extraHeaders?: Record<string, unknown>) => ({
  description,
  ...(extraHeaders ? { headers: extraHeaders } : {}),
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

function operationFor(tool: AnyToolDefinition) {
  const typeName = pascal(tool.name);
  const codes: ToolErrorCode[] = [...COMMON_ERROR_CODES, ...(tool.requiresIdempotencyKey ? IDEMPOTENCY_ERROR_CODES : []), ...tool.errorCodes];

  // Group error codes by HTTP status so each status appears once.
  const byStatus = new Map<number, ToolErrorCode[]>();
  for (const code of codes) {
    const status = TOOL_ERROR_CATALOGUE[code].httpStatus;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }

  const responses: Record<string, unknown> = {
    "200": {
      description: "The tool ran. The body is the tool's output.",
      headers: {
        "RateLimit-Limit": { $ref: "#/components/headers/RateLimitLimit" },
        "RateLimit-Remaining": { $ref: "#/components/headers/RateLimitRemaining" },
        "RateLimit-Reset": { $ref: "#/components/headers/RateLimitReset" },
        ...(tool.requiresIdempotencyKey ? { "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" } } : {}),
      },
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${typeName}Output` },
          examples: Object.fromEntries(tool.examples.map((e) => [slug(e.title), { summary: e.title, value: e.output }])),
        },
      },
    },
  };
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    const list = byStatus.get(status) ?? [];
    responses[String(status)] = errorResponse(
      `Error codes: ${list.join(", ")}.`,
      status === 429
        ? {
            "Retry-After": { $ref: "#/components/headers/RetryAfter" },
            "RateLimit-Limit": { $ref: "#/components/headers/RateLimitLimit" },
            "RateLimit-Remaining": { $ref: "#/components/headers/RateLimitRemaining" },
            "RateLimit-Reset": { $ref: "#/components/headers/RateLimitReset" },
          }
        : undefined,
    );
  }

  return {
    operationId: tool.name,
    summary: tool.title,
    description: tool.description,
    tags: ["Tools"],
    ...(tool.requiresIdempotencyKey ? { parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }] } : {}),
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${typeName}Input` },
          examples: Object.fromEntries(tool.examples.map((e) => [slug(e.title), { summary: e.title, value: e.input }])),
        },
      },
    },
    responses,
    "x-qenbel-permission-level": tool.permissionLevel,
    "x-qenbel-required-permission": tool.requiredPermission,
    "x-qenbel-requires-idempotency-key": tool.requiresIdempotencyKey,
    "x-qenbel-default-channels": [...tool.defaultChannels],
    "x-qenbel-errors": codes.map((code) => ({ code, httpStatus: TOOL_ERROR_CATALOGUE[code].httpStatus, message: TOOL_ERROR_CATALOGUE[code].message })),
  };
}

/**
 * OpenAPI 3.1 document with one `POST /v1/tools/{toolName}` operation per tool (the path is spelled
 * out per tool so each has its own request and response schema). The tenant is never a parameter:
 * it comes from the bearer API key.
 */
export function toOpenApi(tools: readonly AnyToolDefinition[], options: OpenApiOptions): OpenApiDocument {
  const schemas: Record<string, JsonSchema> = {
    Error: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message", "details"],
          properties: {
            code: { type: "string", description: "Stable machine-readable code, e.g. BOOKING_SLOT_TAKEN." },
            message: { type: "string", description: "Plain sentence, safe to show to a customer." },
            details: { type: "object", additionalProperties: true, description: "Extra facts about the error. May be empty." },
          },
        },
      },
    },
  };
  const paths: Record<string, Record<string, unknown>> = {};

  for (const tool of tools) {
    const typeName = pascal(tool.name);
    schemas[`${typeName}Input`] = toInputJsonSchema(tool);
    schemas[`${typeName}Output`] = toOutputJsonSchema(tool);
    paths[`/v1/tools/${tool.name}`] = { post: operationFor(tool) };
  }

  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: options.title,
      version: options.version,
      ...(options.description ? { description: options.description } : {}),
    },
    servers: [{ url: options.serverUrl }],
    tags: [{ name: "Tools", description: "Narrow, permissioned actions for AI agents. Each call is validated and audited on the server." }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "A tenant-scoped QenBel API key sent as `Authorization: Bearer <key>`. The key decides the business and the tools allowed. Never send a tenant id.",
        },
      },
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description: "Unique per intended action. Repeating a call with the same key and body returns the first result for 24 hours. The same key with a different body is an error.",
          schema: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_.:-]{8,128}$" },
        },
      },
      headers: {
        RateLimitLimit: { description: "Requests allowed in the current window.", schema: { type: "integer" } },
        RateLimitRemaining: { description: "Requests left in the current window.", schema: { type: "integer" } },
        RateLimitReset: { description: "Seconds until the window resets.", schema: { type: "integer" } },
        RetryAfter: { description: "Seconds to wait before trying again.", schema: { type: "integer" } },
        IdempotentReplayed: { description: "`true` when this response is the stored result of an earlier call with the same Idempotency-Key.", schema: { type: "string", enum: ["true"] } },
      },
    },
  };
  return doc;
}

/** Options for the committed sample at docs/generated/tools.openapi.json. */
export const SAMPLE_OPENAPI_OPTIONS: OpenApiOptions = {
  title: "QenBel Administration tool gateway",
  version: "1.0.0",
  serverUrl: "https://api.example.com",
  description: "Tools an AI agent can call for one business. Sample generated from @qenbel/tool-registry. Replace the server URL with your own deployment.",
};
