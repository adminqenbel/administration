import type { z } from "zod";
import type { Channel, ToolName, ToolPermissionLevel } from "@qenbel/shared";
import type { ToolErrorCode } from "./errors.ts";

export interface ToolExample<I = unknown, O = unknown> {
  /** Short plain label, e.g. "Haircut on a weekday". */
  title: string;
  input: I;
  output: O;
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** Final registry name. One of `ToolName`. */
  readonly name: ToolName;
  /** Short human label for dashboards and MCP clients. */
  readonly title: string;
  /** Written for an LLM: what it does, when to use it, what it does NOT do. */
  readonly description: string;
  readonly permissionLevel: ToolPermissionLevel;
  /** Permission string the credential or channel must carry, `<module>:<action>`. */
  readonly requiredPermission: string;
  /** Derived: true for every level except READ. The key travels in the `Idempotency-Key` header, never in the input. */
  readonly requiresIdempotencyKey: boolean;
  /** Input as the caller sends it. Never contains tenant or organisation identifiers. */
  readonly input: I;
  readonly output: O;
  readonly examples: readonly ToolExample<z.input<I>, z.output<O>>[];
  /** Codes this tool can return beyond the common ones that apply to every tool. */
  readonly errorCodes: readonly ToolErrorCode[];
  /** Channels that get this tool unless the tenant narrows it further. */
  readonly defaultChannels: readonly Channel[];
}

export type AnyToolDefinition = ToolDefinition<z.ZodType, z.ZodType>;
