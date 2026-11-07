// Typed configuration from environment variables. Fails fast with a list of problems that name the
// variable and the rule, never the value. Nothing here is logged except `describeConfig` (redacted).
import { createPublicKey } from "node:crypto";
import { AuthProviderKind, DeploymentMode } from "@qenbel/shared";
import { resolveDatabaseUrls } from "@qenbel/db";

export type NodeEnv = "development" | "test" | "production";
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface ClerkConfig {
  /** PEM public key of the Clerk instance (verification needs no network call). */
  jwtKey: string;
  issuer: string;
  authorizedParties: readonly string[];
}

export interface RateLimitConfig {
  windowSeconds: number;
  /** Requests per window per client address on authenticated routes. */
  ipMax: number;
  /** Requests per window per client address on public routes. */
  publicMax: number;
  /** Requests per window per principal (user or API credential). */
  principalMax: number;
  /** Failed sign-in attempts per window per client address before it is blocked. */
  authFailMax: number;
}

export interface AppConfig {
  nodeEnv: NodeEnv;
  deploymentMode: DeploymentMode;
  /** Isolated mode only: the one tenant this deployment serves. */
  isolatedTenantId: string | null;
  host: string;
  port: number;
  publicApiOrigin: string;
  publicWebOrigin: string;
  databaseUrl: string;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  redisUrl: string | null;
  authProvider: AuthProviderKind;
  clerk: ClerkConfig | null;
  apiKeyPepper: string;
  apiKeyPepperVersion: number;
  /** Number of reverse proxies in front of the API (0 = none). */
  trustProxy: number;
  bodyLimitBytes: number;
  logLevel: LogLevel;
  rateLimit: RateLimitConfig;
  idempotency: { waitMs: number; lockTimeoutMs: number };
  shutdownTimeoutMs: number;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** Normalise a PEM that was stored in an env file with escaped newlines. */
export function normalisePem(value: string): string {
  return value.trim().replace(/\\n/g, "\n");
}

export function parsePublicKey(pem: string) {
  return createPublicKey(normalisePem(pem));
}

type Env = Record<string, string | undefined>;

class Reader {
  readonly issues: string[] = [];
  constructor(private readonly env: Env) {}

  raw(name: string): string | undefined {
    const v = this.env[name];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  }

  string(name: string, opts: { required?: boolean; fallback?: string; min?: number } = {}): string | undefined {
    const v = this.raw(name) ?? opts.fallback;
    if (v === undefined) {
      if (opts.required) this.issues.push(`${name} is required`);
      return undefined;
    }
    if (opts.min !== undefined && v.length < opts.min) {
      this.issues.push(`${name} must be at least ${opts.min} characters`);
      return undefined;
    }
    return v;
  }

  int(name: string, fallback: number, min: number, max: number): number {
    const v = this.raw(name);
    if (v === undefined) return fallback;
    if (!/^-?\d+$/.test(v)) {
      this.issues.push(`${name} must be an integer`);
      return fallback;
    }
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      this.issues.push(`${name} must be between ${min} and ${max}`);
      return fallback;
    }
    return n;
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const v = this.raw(name);
    if (v === undefined) return fallback;
    if (!(allowed as readonly string[]).includes(v)) {
      this.issues.push(`${name} must be one of: ${allowed.join(", ")}`);
      return fallback;
    }
    return v as T;
  }

  origin(name: string, fallbackForDev: string | undefined, isProduction: boolean): string {
    const v = this.raw(name) ?? fallbackForDev;
    if (v === undefined) {
      this.issues.push(`${name} is required`);
      return "";
    }
    try {
      const u = new URL(v);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
      if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) throw new Error("not an origin");
      if (isProduction && u.protocol !== "https:") {
        this.issues.push(`${name} must use https in production`);
      }
      return u.origin;
    } catch {
      this.issues.push(`${name} must be an origin such as https://example.com (no path, query or credentials)`);
      return "";
    }
  }
}

/** Read and validate configuration. Throws `ConfigError`. Pass an env object in tests. */
export function loadConfig(env: Env = process.env): AppConfig {
  const r = new Reader(env);

  // Unset NODE_ENV is treated as production so that a forgotten variable can only make things stricter.
  const nodeEnv = r.oneOf<NodeEnv>("NODE_ENV", ["development", "test", "production"], "production");
  const isProduction = nodeEnv === "production";
  const isDev = nodeEnv === "development";

  const deploymentMode = r.oneOf<DeploymentMode>("DEPLOYMENT_MODE", Object.values(DeploymentMode), DeploymentMode.CENTRAL);
  let isolatedTenantId: string | null = null;
  if (deploymentMode === DeploymentMode.ISOLATED) {
    const id = r.string("ISOLATED_TENANT_ID", { required: true });
    if (id !== undefined) {
      if (UUID_RE.test(id)) isolatedTenantId = id.toLowerCase();
      else r.issues.push("ISOLATED_TENANT_ID must be a UUID");
    }
  } else if (r.raw("ISOLATED_TENANT_ID") !== undefined) {
    r.issues.push("ISOLATED_TENANT_ID is only valid when DEPLOYMENT_MODE=isolated");
  }

  const host = r.string("HOST", { fallback: "127.0.0.1" }) as string;
  const port = r.int("PORT", 4000, 0, 65535);
  const publicApiOrigin = r.origin("PUBLIC_API_ORIGIN", isDev || nodeEnv === "test" ? `http://localhost:${port}` : undefined, isProduction);
  const publicWebOrigin = r.origin("PUBLIC_WEB_ORIGIN", isDev || nodeEnv === "test" ? "http://localhost:5173" : undefined, isProduction);

  let databaseUrl = r.string("DATABASE_URL");
  if (databaseUrl === undefined) {
    if (isDev) {
      try {
        databaseUrl = resolveDatabaseUrls().appUrl;
      } catch {
        r.issues.push("DATABASE_URL is required (or POSTGRES_PASSWORD in infra/.env for local development)");
      }
    } else {
      r.issues.push("DATABASE_URL is required");
    }
  }

  const authProvider = r.oneOf<AuthProviderKind>(
    "AUTH_PROVIDER",
    Object.values(AuthProviderKind),
    AuthProviderKind.CLERK,
  );

  // The dev provider is a fake identity. It can only exist in a development process bound to this machine.
  if (authProvider === AuthProviderKind.DEV) {
    if (!isDev) r.issues.push("AUTH_PROVIDER=dev is allowed only when NODE_ENV=development");
    if (!isLoopbackHost(host)) r.issues.push("AUTH_PROVIDER=dev is allowed only when HOST is a loopback address (127.0.0.1 or ::1)");
  }

  let clerk: ClerkConfig | null = null;
  if (authProvider === AuthProviderKind.CLERK) {
    const jwtKey = r.string("CLERK_JWT_KEY", { required: true });
    const issuer = r.string("CLERK_ISSUER", { required: true });
    if (jwtKey !== undefined) {
      try {
        parsePublicKey(jwtKey);
      } catch {
        r.issues.push("CLERK_JWT_KEY must be a PEM public key");
      }
    }
    const partiesRaw = r.raw("CLERK_AUTHORIZED_PARTIES");
    const authorizedParties = (partiesRaw ? partiesRaw.split(",") : [publicWebOrigin])
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (authorizedParties.length === 0) r.issues.push("CLERK_AUTHORIZED_PARTIES must list at least one origin");
    if (jwtKey !== undefined && issuer !== undefined) {
      clerk = { jwtKey: normalisePem(jwtKey), issuer, authorizedParties };
    }
  }

  const apiKeyPepper = r.string("API_KEY_PEPPER", { required: true, min: 32 }) ?? "";
  const apiKeyPepperVersion = r.int("API_KEY_PEPPER_VERSION", 1, 1, 32767);

  const redisUrl = r.string("REDIS_URL") ?? null;
  if (redisUrl !== null && !/^rediss?:\/\//.test(redisUrl)) r.issues.push("REDIS_URL must start with redis:// or rediss://");

  const config: AppConfig = {
    nodeEnv,
    deploymentMode,
    isolatedTenantId,
    host,
    port,
    publicApiOrigin,
    publicWebOrigin,
    databaseUrl: databaseUrl ?? "",
    dbPoolMax: r.int("DB_POOL_MAX", 10, 1, 100),
    dbStatementTimeoutMs: r.int("DB_STATEMENT_TIMEOUT_MS", 15_000, 100, 120_000),
    redisUrl,
    authProvider,
    clerk,
    apiKeyPepper,
    apiKeyPepperVersion,
    trustProxy: r.int("TRUST_PROXY", 0, 0, 10),
    bodyLimitBytes: r.int("BODY_LIMIT_BYTES", 256 * 1024, 1024, 5 * 1024 * 1024),
    logLevel: r.oneOf<LogLevel>("LOG_LEVEL", ["debug", "info", "warn", "error", "silent"], "info"),
    rateLimit: {
      windowSeconds: r.int("RATE_LIMIT_WINDOW_SECONDS", 60, 1, 3600),
      ipMax: r.int("RATE_LIMIT_IP_MAX", 600, 1, 1_000_000),
      publicMax: r.int("RATE_LIMIT_PUBLIC_MAX", 60, 1, 1_000_000),
      principalMax: r.int("RATE_LIMIT_PRINCIPAL_MAX", 600, 1, 1_000_000),
      authFailMax: r.int("RATE_LIMIT_AUTH_FAIL_MAX", 20, 1, 10_000),
    },
    idempotency: {
      waitMs: r.int("IDEMPOTENCY_WAIT_MS", 5_000, 0, 60_000),
      lockTimeoutMs: r.int("IDEMPOTENCY_LOCK_TIMEOUT_MS", 60_000, 1_000, 600_000),
    },
    shutdownTimeoutMs: r.int("SHUTDOWN_TIMEOUT_MS", 10_000, 100, 120_000),
  };

  if (r.issues.length > 0) throw new ConfigError(r.issues);
  return Object.freeze(config);
}

/**
 * Last line of defence for the dev provider. `loadConfig` already refuses the combination, but a config
 * object can be built by hand (tests, embedding), so the app re-checks before it starts.
 */
export function assertSafeAuthConfig(config: AppConfig): void {
  const problems: string[] = [];
  if (config.authProvider === AuthProviderKind.DEV) {
    if (config.nodeEnv !== "development") problems.push("AUTH_PROVIDER=dev is allowed only when NODE_ENV=development");
    if (!isLoopbackHost(config.host)) problems.push("AUTH_PROVIDER=dev is allowed only on a loopback HOST");
  }
  if (config.authProvider === AuthProviderKind.CLERK && !config.clerk) problems.push("AUTH_PROVIDER=clerk needs CLERK_JWT_KEY and CLERK_ISSUER");
  if (config.deploymentMode === DeploymentMode.ISOLATED && !config.isolatedTenantId) problems.push("DEPLOYMENT_MODE=isolated needs ISOLATED_TENANT_ID");
  if (config.apiKeyPepper.length < 32) problems.push("API_KEY_PEPPER must be at least 32 characters");
  if (problems.length > 0) throw new ConfigError(problems);
}

/** A copy that is safe to log: no secrets, no connection strings. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    deploymentMode: config.deploymentMode,
    host: config.host,
    port: config.port,
    publicApiOrigin: config.publicApiOrigin,
    publicWebOrigin: config.publicWebOrigin,
    authProvider: config.authProvider,
    redis: config.redisUrl ? "configured" : "off",
    trustProxy: config.trustProxy,
    bodyLimitBytes: config.bodyLimitBytes,
    rateLimit: config.rateLimit,
  };
}
