import "reflect-metadata";
import { json } from "express";
import { NestFactory } from "@nestjs/core";
import type { LoggerService, Provider, Type } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createPool, type Pool } from "@qenbel/db";
import { AuthProviderKind } from "@qenbel/shared";
import { AppModule } from "./app.module.ts";
import { createClerkProvider } from "./auth/clerk.provider.ts";
import { createDevProvider } from "./auth/dev.provider.ts";
import type { AuthProvider } from "./auth/auth-provider.ts";
import { accessLog, cors, requestId, requireJsonBody, securityHeaders } from "./common/http-middleware.ts";
import { AppLogger } from "./common/logger.ts";
import { type AppConfig, assertSafeAuthConfig } from "./config/config.ts";
import { FallbackRateLimiter, InMemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./ratelimit/rate-limiter.ts";

export const GLOBAL_PREFIX = "v1";
/** Served outside the /v1 prefix so infrastructure probes have a stable path. */
export const UNPREFIXED_ROUTES = ["health", "health/db"] as const;

export interface CreateAppOptions {
  config: AppConfig;
  logger?: AppLogger;
  /** Supply a pool (tests). Otherwise one is created from DATABASE_URL and closed on shutdown. */
  pool?: Pool;
  limiter?: RateLimiter;
  authProvider?: AuthProvider;
  clock?: () => Date;
  extraControllers?: Type[];
  extraProviders?: Provider[];
}

/** Routes Nest's own startup logging through ours, so it is JSON and redacted too. */
class NestLogAdapter implements LoggerService {
  constructor(private readonly logger: AppLogger) {}
  log(message: unknown, ..._rest: unknown[]) {
    this.logger.debug(String(message));
  }
  error(message: unknown, ..._rest: unknown[]) {
    this.logger.error(String(message));
  }
  warn(message: unknown, ..._rest: unknown[]) {
    this.logger.warn(String(message));
  }
  debug(message: unknown, ..._rest: unknown[]) {
    this.logger.debug(String(message));
  }
  verbose(message: unknown, ..._rest: unknown[]) {
    this.logger.debug(String(message));
  }
}

export async function buildAuthProvider(config: AppConfig): Promise<AuthProvider> {
  if (config.authProvider === AuthProviderKind.DEV) return createDevProvider(config);
  if (!config.clerk) throw new Error("AUTH_PROVIDER=clerk needs CLERK_JWT_KEY and CLERK_ISSUER");
  return createClerkProvider(config.clerk);
}

export async function buildRateLimiter(config: AppConfig, logger: AppLogger): Promise<RateLimiter> {
  const memory = new InMemoryRateLimiter();
  if (!config.redisUrl) return memory;
  return new FallbackRateLimiter(new RedisRateLimiter(config.redisUrl), memory, logger);
}

/**
 * Builds the configured application (not yet listening). Everything the HTTP layer needs is wired here:
 * request id, access log, security headers, CORS, JSON-only bodies with a size limit, global guard,
 * interceptor and error filter (through CoreModule), the /v1 prefix.
 */
export async function createApp(options: CreateAppOptions): Promise<NestExpressApplication> {
  const { config } = options;
  assertSafeAuthConfig(config);
  const logger = options.logger ?? new AppLogger(config.logLevel);
  const ownsPool = options.pool === undefined;
  const pool =
    options.pool ??
    createPool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      statementTimeoutMs: config.dbStatementTimeoutMs,
      applicationName: "qenbel-api",
    });
  const authProvider = options.authProvider ?? (await buildAuthProvider(config));
  const limiter = options.limiter ?? (await buildRateLimiter(config, logger));

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({
      deps: { config, logger, pool, ownsPool, limiter, authProvider, clock: options.clock ?? (() => new Date()) },
      extraControllers: options.extraControllers,
      extraProviders: options.extraProviders,
    }),
    { bodyParser: false, logger: new NestLogAdapter(logger), abortOnError: false },
  );

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.set("etag", false);
  app.use(requestId());
  app.use(accessLog(logger));
  app.use(securityHeaders(config));
  app.use(cors(config));
  app.use(requireJsonBody());
  app.use(json({ limit: config.bodyLimitBytes, strict: true, type: "application/json" }));
  app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: [...UNPREFIXED_ROUTES] });
  await app.init();
  return app;
}
