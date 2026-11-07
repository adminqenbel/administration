// Structured JSON logging with redaction. Request and response bodies are never logged. Headers are never
// logged. Anything under a key that looks like a secret is replaced, and secret-shaped strings are scrubbed
// from values (error messages, stack traces).
import type { LogLevel } from "../config/config.ts";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const SECRET_KEY = /authorization|cookie|token|secret|password|passwd|pepper|api[-_]?key|jwt|credential|connection|dsn|database[-_]?url|redis[-_]?url|private|signature/i;
const REDACTED = "[redacted]";

const SCRUBBERS: Array<[RegExp, string]> = [
  [/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\bqbk_[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{8,})?/g, "qbk_[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]"],
  [/\b(postgres(?:ql)?|rediss?|mongodb|amqp):\/\/[^\s'"]*/gi, "$1://[redacted]"],
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[redacted-pem]"],
];

export function scrubString(value: string): string {
  let out = value;
  for (const [re, rep] of SCRUBBERS) out = out.replace(re, rep);
  return out.length > 2000 ? `${out.slice(0, 2000)}...` : out;
}

/** Deep copy with secret-named keys replaced and secret-shaped strings scrubbed. Depth and size bounded. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return errorFields(value);
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function errorFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: scrubString(String(err)) };
  const out: Record<string, unknown> = { name: err.name, message: scrubString(err.message) };
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") out.code = code;
  const constraint = (err as { constraint?: unknown }).constraint;
  if (typeof constraint === "string") out.constraint = constraint;
  if (err.stack) out.stack = scrubString(err.stack);
  return out;
}

export interface LogSink {
  write(line: string): void;
}

export const stdoutSink: LogSink = { write: (line) => void process.stdout.write(`${line}\n`) };

export class AppLogger {
  readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly base: Record<string, unknown>;

  constructor(level: LogLevel = "info", sink: LogSink = stdoutSink, base: Record<string, unknown> = {}) {
    this.level = level;
    this.sink = sink;
    this.base = base;
  }

  child(fields: Record<string, unknown>): AppLogger {
    return new AppLogger(this.level, this.sink, { ...this.base, ...fields });
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log("error", msg, fields);
  }

  private log(level: Exclude<LogLevel, "silent">, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: scrubString(msg),
      ...(redact({ ...this.base, ...fields }) as Record<string, unknown>),
    };
    try {
      this.sink.write(JSON.stringify(record));
    } catch {
      // logging must never break a request
    }
  }
}

/** Collects lines in memory. For tests. */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
  records(): Array<Record<string, unknown>> {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}
