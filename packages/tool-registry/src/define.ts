import type { z } from "zod";
import { ToolPermissionLevel } from "@qenbel/shared";
import type { Channel, ToolName } from "@qenbel/shared";
import type { ToolErrorCode } from "./errors.ts";
import type { ToolDefinition, ToolExample } from "./types.ts";

export interface ToolSpec<I extends z.ZodType, O extends z.ZodType> {
  name: ToolName;
  title: string;
  description: string;
  permissionLevel: ToolPermissionLevel;
  requiredPermission: string;
  input: I;
  output: O;
  examples: readonly ToolExample<z.input<I>, z.output<O>>[];
  errorCodes: readonly ToolErrorCode[];
  defaultChannels: readonly Channel[];
}

/**
 * Builds a tool definition. The idempotency flag is derived from the permission level, so a write
 * tool cannot be declared without it.
 */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(spec: ToolSpec<I, O>): ToolDefinition<I, O> {
  return Object.freeze({
    ...spec,
    requiresIdempotencyKey: spec.permissionLevel !== ToolPermissionLevel.READ,
  });
}
