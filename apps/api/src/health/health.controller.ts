import { Controller, Get, Inject } from "@nestjs/common";
import { AppError, ErrorCode } from "@qenbel/shared";
import type { Pool } from "@qenbel/db";
import { Public } from "../authz/decorators.ts";
import { DB_POOL } from "../common/tokens.ts";

/** Liveness and database readiness for the platform. No version, no tenant data, nothing about the cause of a failure. */
@Controller("health")
export class HealthController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  @Public()
  @Get()
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Public()
  @Get("db")
  async db(): Promise<{ status: "ok" }> {
    try {
      await this.pool.query("select 1");
    } catch {
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE);
    }
    return { status: "ok" };
  }
}
