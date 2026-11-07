import { ToolName } from "@qenbel/shared";

const KNOWN: ReadonlySet<string> = new Set(Object.values(ToolName));

/** Keeps only names that are real tools, so a stray value in a column can never widen access. */
export function toolNames(values: readonly string[]): ToolName[] {
  return values.filter((v): v is ToolName => KNOWN.has(v));
}

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && KNOWN.has(value);
}
