import { ToolName } from "@qenbel/shared";
import { ALL_TOOLS } from "./tools.ts";
import type { AnyToolDefinition } from "./types.ts";

export class UnknownToolError extends Error {
  readonly toolName: string;
  constructor(toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = "UnknownToolError";
    this.toolName = toolName;
  }
}

const TOOLS: readonly AnyToolDefinition[] = Object.freeze([...ALL_TOOLS]);
const BY_NAME: ReadonlyMap<string, AnyToolDefinition> = new Map(TOOLS.map((t) => [t.name, t]));

// Fail at load time if the registry and the contract enum ever disagree.
{
  const expected = new Set<string>(Object.values(ToolName));
  if (BY_NAME.size !== TOOLS.length) throw new Error("tool-registry: duplicate tool name");
  for (const n of expected) if (!BY_NAME.has(n)) throw new Error(`tool-registry: missing tool ${n}`);
  for (const n of BY_NAME.keys()) if (!expected.has(n)) throw new Error(`tool-registry: tool ${n} is not in ToolName`);
}

/** Every tool, in the order of docs/ARCHITECTURE.md section 6. */
export function listTools(): readonly AnyToolDefinition[] {
  return TOOLS;
}

/** The tool with this name, or `undefined`. Callers must treat `undefined` as TOOL_NOT_FOUND. */
export function getTool(name: string): AnyToolDefinition | undefined {
  return BY_NAME.get(name);
}

/**
 * The tools a config pack allows, in registry order, without duplicates. An unknown name in the
 * allow-list is a pack bug and throws, so it cannot silently widen or narrow access.
 */
export function toolsForPack(allowList: readonly string[]): readonly AnyToolDefinition[] {
  const wanted = new Set<string>();
  for (const name of allowList) {
    if (!BY_NAME.has(name)) throw new UnknownToolError(name);
    wanted.add(name);
  }
  return TOOLS.filter((t) => wanted.has(t.name));
}
