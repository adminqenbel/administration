// Cross-cutting providers, global so every feature module (and every future Stage 3 module) can inject
// them. Also registers the three global enhancers: the access guard (deny by default), the tenant unit of
// work, and the error filter.
import { type DynamicModule, Global, Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import type { Pool } from "@qenbel/db";
import { AuditService } from "./audit/audit.service.ts";
import { AuthenticationService } from "./auth/authentication.service.ts";
import type { AuthProvider } from "./auth/auth-provider.ts";
import { AccessGuard } from "./authz/access.guard.ts";
import type { AppLogger } from "./common/logger.ts";
import { AUTH_PROVIDER, CLOCK, CONFIG, DB_POOL, LOGGER, RATE_LIMITER } from "./common/tokens.ts";
import type { AppConfig } from "./config/config.ts";
import { AllExceptionsFilter } from "./errors/exception.filter.ts";
import { IdempotencyInterceptor } from "./idempotency/idempotency.interceptor.ts";
import { IdempotencyService } from "./idempotency/idempotency.service.ts";
import type { RateLimiter } from "./ratelimit/rate-limiter.ts";
import { TenantUnitOfWorkInterceptor } from "./tenancy/tenant-unit-of-work.interceptor.ts";
import { UnitOfWork } from "./tenancy/unit-of-work.service.ts";

export interface CoreDeps {
  config: AppConfig;
  logger: AppLogger;
  pool: Pool;
  /** True when the app created the pool and must end it on shutdown. */
  ownsPool: boolean;
  limiter: RateLimiter;
  authProvider: AuthProvider;
  clock: () => Date;
}

export const OWNS_POOL = Symbol("QENBEL_OWNS_POOL");

@Injectable()
class ShutdownHooks implements OnModuleDestroy {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(OWNS_POOL) private readonly ownsPool: boolean,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.limiter.close();
    if (this.ownsPool) await this.pool.end();
    this.logger.info("resources closed");
  }
}

@Global()
@Module({})
export class CoreModule {
  static forRoot(deps: CoreDeps): DynamicModule {
    return {
      module: CoreModule,
      global: true,
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: LOGGER, useValue: deps.logger },
        { provide: DB_POOL, useValue: deps.pool },
        { provide: OWNS_POOL, useValue: deps.ownsPool },
        { provide: RATE_LIMITER, useValue: deps.limiter },
        { provide: AUTH_PROVIDER, useValue: deps.authProvider },
        { provide: CLOCK, useValue: deps.clock },
        AuthenticationService,
        AuditService,
        UnitOfWork,
        IdempotencyService,
        IdempotencyInterceptor,
        ShutdownHooks,
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantUnitOfWorkInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
      exports: [
        CONFIG,
        LOGGER,
        DB_POOL,
        RATE_LIMITER,
        AUTH_PROVIDER,
        CLOCK,
        AuthenticationService,
        AuditService,
        UnitOfWork,
        IdempotencyService,
        IdempotencyInterceptor,
      ],
    };
  }
}
