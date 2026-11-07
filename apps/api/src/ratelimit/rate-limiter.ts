// Fixed-window rate limiting. Redis-backed when REDIS_URL is set, with an in-memory fallback so a Redis
// outage degrades to per-process limits instead of taking the API down (or leaving it unlimited).
import { Redis } from "ioredis";
import type { AppLogger } from "../common/logger.ts";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
}

export interface RateLimiter {
  /** Count one request against `key`. */
  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Current state without counting. */
  peek(key: string, limit: number): Promise<RateLimitResult>;
  close(): Promise<void>;
}

const MAX_KEYS = 50_000;

interface Bucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= t) {
      this.makeRoom(t);
      b = { count: 0, resetAt: t + windowSeconds * 1000 };
      this.buckets.set(key, b);
    }
    b.count += 1;
    return this.result(b, limit, t);
  }

  async peek(key: string, limit: number): Promise<RateLimitResult> {
    const t = this.now();
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= t) return { allowed: true, limit, remaining: limit, resetSeconds: 0 };
    return this.result(b, limit, t, false);
  }

  async close(): Promise<void> {
    this.buckets.clear();
  }

  size(): number {
    return this.buckets.size;
  }

  private result(b: Bucket, limit: number, t: number, counted = true): RateLimitResult {
    const allowed = counted ? b.count <= limit : b.count < limit;
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - b.count),
      resetSeconds: Math.max(1, Math.ceil((b.resetAt - t) / 1000)),
    };
  }

  private makeRoom(t: number): void {
    if (this.buckets.size < MAX_KEYS) return;
    for (const [k, v] of this.buckets) if (v.resetAt <= t) this.buckets.delete(k);
    if (this.buckets.size < MAX_KEYS) return;
    // Still full of live keys (an attack with many addresses): drop the oldest tenth.
    let drop = Math.ceil(MAX_KEYS / 10);
    for (const k of this.buckets.keys()) {
      this.buckets.delete(k);
      if (--drop <= 0) break;
    }
  }
}

const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {c, ttl}
`;

export class RedisRateLimiter implements RateLimiter {
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(url: string, options: { prefix?: string } = {}) {
    this.prefix = options.prefix ?? "qenbel:rl:";
    this.redis = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true, // commands wait for the connection; commandTimeout bounds the wait
      connectTimeout: 2_000,
      commandTimeout: 1_000,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    // An unreachable Redis must not crash the process; hit() throws and the fallback takes over.
    this.redis.on("error", () => undefined);
  }

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const [count, ttl] = (await this.redis.eval(HIT_SCRIPT, 1, this.prefix + key, String(windowSeconds * 1000))) as [number, number];
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetSeconds: Math.max(1, Math.ceil(ttl / 1000)),
    };
  }

  async peek(key: string, limit: number): Promise<RateLimitResult> {
    const k = this.prefix + key;
    const [raw, ttl] = await Promise.all([this.redis.get(k), this.redis.pttl(k)]);
    const count = raw === null ? 0 : Number(raw);
    return {
      allowed: count < limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetSeconds: ttl > 0 ? Math.ceil(ttl / 1000) : 0,
    };
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }

  /** For tests: delete keys this limiter created. */
  async deleteKey(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}

/** Uses `primary`; when it throws, falls back to `fallback` (and says so, at most once a minute). */
export class FallbackRateLimiter implements RateLimiter {
  private lastWarn = 0;

  constructor(
    private readonly primary: RateLimiter,
    private readonly fallback: RateLimiter,
    private readonly logger: AppLogger,
  ) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    try {
      return await this.primary.hit(key, limit, windowSeconds);
    } catch (err) {
      this.warn(err);
      return this.fallback.hit(key, limit, windowSeconds);
    }
  }

  async peek(key: string, limit: number): Promise<RateLimitResult> {
    try {
      return await this.primary.peek(key, limit);
    } catch (err) {
      this.warn(err);
      return this.fallback.peek(key, limit);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.primary.close(), this.fallback.close()]);
  }

  private warn(err: unknown): void {
    const t = Date.now();
    if (t - this.lastWarn < 60_000) return;
    this.lastWarn = t;
    this.logger.warn("rate limiter store unavailable, using in-memory limits", { reason: err instanceof Error ? err.name : "error" });
  }
}
