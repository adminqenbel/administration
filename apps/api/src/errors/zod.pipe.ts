import { type PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { validationError } from "@qenbel/shared";

/**
 * Validates a body or query with a zod schema. On failure: 400 VALIDATION_FAILED listing field paths and
 * rules, never the submitted values. Build schemas with `z.strictObject` so unknown keys (tenantId, role,
 * anything not declared) are refused instead of silently dropped.
 */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) throw validationError(result.error);
    return result.data;
  }
}

export const zodPipe = <S extends z.ZodType>(schema: S): ZodPipe<S> => new ZodPipe(schema);
