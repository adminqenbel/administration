// Shared plumbing for the catalogue engine: operation wrapper, Postgres error mapping, cursors,
// outbox writer, small row helpers. Nothing here takes a tenant id from input: it comes from ctx only.
import { z } from "zod";
import {
  AppError,
  Channel,
  ErrorCode,
  idSchema,
  isPaise,
  parseOrThrow,
  type DomainEventInput,
  type EngineContext,
  type SqlClient,
} from "@qenbel/shared";

export type { EngineContext, SqlClient, DomainEventInput };

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const limitSchema = z.number().int().min(1).max(100).default(25);
export const cursorSchema = z.string().min(1).max(512).optional();
export const idArg = idSchema;

/** Plain text: trimmed, bounded, no control characters other than tab and newline. */
export function text(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((v) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v), "Control characters are not allowed");
}

// ---- operation wrapper ----------------------------------------------------------------------------

function assertContext(ctx: EngineContext): void {
  if (!ctx || typeof ctx.tenantId !== "string" || !GUID_RE.test(ctx.tenantId)) {
    throw new AppError(ErrorCode.TENANT_REQUIRED);
  }
}

/** Customer contact uniqueness enforced by the database (migration 014): constraint name -> field. */
export const CONTACT_UNIQUE_FIELDS: Readonly<Record<string, "phone" | "email">> = {
  customers_active_phone_unique: "phone",
  customers_active_email_unique: "email",
};

/** True for a 23505 on one of the customer contact unique indexes. */
export function isContactUnique(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === "23505" && typeof e.constraint === "string" && e.constraint in CONTACT_UNIQUE_FIELDS;
}

let savepointCounter = 0;

/**
 * Run `fn` inside a savepoint so a failing statement (a unique violation we want to handle) does not abort the whole
 * transaction. On error the savepoint is rolled back and the error is rethrown unchanged.
 */
export async function withSavepoint<T>(sql: SqlClient, fn: () => Promise<T>): Promise<T> {
  const name = `sp_engine_${++savepointCounter}`;
  await sql.query(`savepoint ${name}`);
  try {
    const out = await fn();
    await sql.query(`release savepoint ${name}`);
    return out;
  } catch (err) {
    await sql.query(`rollback to savepoint ${name}`);
    await sql.query(`release savepoint ${name}`);
    throw err;
  }
}

/** Translate Postgres errors to AppError. The database message is never copied to the caller. */
export function mapPgError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  const e = err as { code?: unknown; constraint?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : undefined;
  const constraint = typeof e?.constraint === "string" ? e.constraint : undefined;
  switch (code) {
    case "23505": {
      const field = constraint ? CONTACT_UNIQUE_FIELDS[constraint] : undefined;
      return new AppError(
        ErrorCode.CONFLICT,
        field ? `Another customer already has this ${field === "phone" ? "phone number" : "email address"}.` : "A record with these details already exists.",
        field ? { field } : {},
      );
    }
    case "23503":
      return new AppError(ErrorCode.VALIDATION_FAILED, "A record this refers to does not exist, or is still in use.", {});
    case "23514":
    case "22P02":
    case "22007":
    case "22008":
    case "22003":
    case "23502":
      return new AppError(ErrorCode.VALIDATION_FAILED, "A value is not acceptable.", {});
    case "55000":
      return new AppError(ErrorCode.CONFLICT, "This change is not allowed while the record is in use.", {});
    case "23P01":
      return new AppError(ErrorCode.CONFLICT, "This conflicts with an existing record.", {});
    default:
      return err;
  }
}

// ---- channel gating ---------------------------------------------------------------------------------

/**
 * Same split as engine-bookings (src/access.ts) and engine-orders (src/scope.ts): web_chat, whatsapp and voice are
 * end-customer channels; dashboard (staff) and api (a trusted server integration with its own credential, whose
 * permissions and tool scopes the API enforces) are trusted. Channel is a closed enum; a value outside it is treated as a
 * customer channel here (fail closed) rather than as trusted.
 */
const STAFF_CHANNELS: ReadonlySet<string> = new Set([Channel.DASHBOARD, Channel.API]);

export function isStaffChannel(ctx: EngineContext): boolean {
  return STAFF_CHANNELS.has(ctx.actor?.channel as string);
}

/** Dashboard-only (staff) operations are refused on customer channels before any input is read or SQL runs. */
export function requireStaff(ctx: EngineContext): void {
  if (!isStaffChannel(ctx)) throw new AppError(ErrorCode.FORBIDDEN, "This action is not available on this channel.", { reason: "CHANNEL_NOT_ALLOWED" });
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The verified end customer of a customer-channel call (`ctx.subject.customerId`, set only by the channel layer),
 * lower-cased, or null when absent or malformed. Never read from tool input.
 */
export function subjectCustomerId(ctx: EngineContext): string | null {
  const id = ctx.subject?.customerId;
  return typeof id === "string" && GUID.test(id) ? id.toLowerCase() : null;
}

/** Define an engine function: validate input (strict zod), check the context, map database errors. */
export function op<S extends z.ZodType, R>(
  schema: S,
  handler: (sql: SqlClient, ctx: EngineContext, input: z.output<S>) => Promise<R>,
  options: { staffOnly?: boolean } = {},
): (sql: SqlClient, ctx: EngineContext, input: z.input<S>) => Promise<R> {
  return async (sql, ctx, input) => {
    try {
      assertContext(ctx);
      if (options.staffOnly) requireStaff(ctx);
      const parsed = parseOrThrow(schema, input);
      return await handler(sql, ctx, parsed);
    } catch (err) {
      throw mapPgError(err);
    }
  };
}

/** Staff-only engine function: like `op`, but refused (FORBIDDEN) on customer channels. */
export function staffOp<S extends z.ZodType, R>(
  schema: S,
  handler: (sql: SqlClient, ctx: EngineContext, input: z.output<S>) => Promise<R>,
): (sql: SqlClient, ctx: EngineContext, input: z.input<S>) => Promise<R> {
  return op(schema, handler, { staffOnly: true });
}

/** Staff-only engine function with no input. */
export function staffOp0<R>(handler: (sql: SqlClient, ctx: EngineContext) => Promise<R>): (sql: SqlClient, ctx: EngineContext) => Promise<R> {
  return op0(handler, { staffOnly: true });
}

/** Engine function with no input. */
export function op0<R>(
  handler: (sql: SqlClient, ctx: EngineContext) => Promise<R>,
  options: { staffOnly?: boolean } = {},
): (sql: SqlClient, ctx: EngineContext) => Promise<R> {
  return async (sql, ctx) => {
    try {
      assertContext(ctx);
      if (options.staffOnly) requireStaff(ctx);
      return await handler(sql, ctx);
    } catch (err) {
      throw mapPgError(err);
    }
  };
}

export function notFound(entity: string): AppError {
  return new AppError(ErrorCode.NOT_FOUND, `${entity} not found.`, { entity });
}

// ---- cursors --------------------------------------------------------------------------------------

/** Opaque cursor: base64url of a JSON array of strings. Values only ever reach SQL as parameters. */
export function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined, length: number): string[] | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === length && parsed.every((p) => typeof p === "string" && p.length <= 300)) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  throw new AppError(ErrorCode.VALIDATION_FAILED, "The cursor is not valid.", { issues: [{ path: "cursor", message: "Invalid cursor" }] });
}

/** SQL fragment: a timestamptz column as a lossless UTC text value, for use in cursors. */
export const tsText = (col: string): string => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Take `limit` rows from a `limit + 1` fetch and build the next cursor from the last returned row. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => string[]): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1] as T;
  return { items, nextCursor: encodeCursor(cursorOf(last)) };
}

// ---- values ---------------------------------------------------------------------------------------

/** bigint columns arrive as strings. Integer paise only; anything else is a data error. */
export function paise(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!isPaise(n)) throw new AppError(ErrorCode.INTERNAL, "Stored amount is not a safe integer.");
  return n;
}

export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function isoReq(value: Date | string): string {
  return iso(value) as string;
}

/** "09:00:00" -> "09:00"; "24:00:00" stays "24:00". */
export function hm(value: string): string {
  return value.slice(0, 5);
}

/** Escape LIKE metacharacters for use with ESCAPE '\'. */
export function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function count(value: unknown): number {
  return Number(value ?? 0);
}

// ---- tenant-scoped existence checks ---------------------------------------------------------------

const CHECKABLE_TABLES = new Set([
  "customers", "locations", "resources", "catalogue_items", "catalogue_categories", "catalogue_variants",
  "bookings", "orders", "conversations", "users", "follow_up_tasks",
]);

/** Throws NOT_FOUND (naming the field) unless the row exists for this tenant. Table names are a fixed allow-list. */
export async function assertRef(sql: SqlClient, ctx: EngineContext, table: string, id: string, field: string): Promise<void> {
  if (!CHECKABLE_TABLES.has(table)) throw new AppError(ErrorCode.INTERNAL);
  const res = await sql.query(`select 1 from ${table} where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (res.rows.length === 0) throw new AppError(ErrorCode.NOT_FOUND, "A record you referred to was not found.", { field });
}

// ---- outbox ---------------------------------------------------------------------------------------

/** Write a domain event in the caller's transaction. Returns the event id subscribers will see. */
export async function emitEvent(sql: SqlClient, ctx: EngineContext, event: DomainEventInput): Promise<string> {
  const res = await sql.query<{ event_id: string }>(
    `insert into outbox_events (tenant_id, type, aggregate_type, aggregate_id, payload)
     values ($1, $2, $3, $4, $5::jsonb) returning event_id`,
    [ctx.tenantId, event.type, event.aggregateType, event.aggregateId, JSON.stringify(event.payload)],
  );
  return (res.rows[0] as { event_id: string }).event_id;
}

/** Serialise concurrent work on a logical key (for example one phone number) inside this transaction. */
export async function lockKeys(sql: SqlClient, ctx: EngineContext, keys: readonly string[]): Promise<void> {
  const sorted = [...new Set(keys)].sort();
  for (const key of sorted) {
    await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${ctx.tenantId}:${key}`]);
  }
}

/** Dynamic UPDATE builder: column names come from code, values are always parameters. */
export class SetBuilder {
  private cols: string[] = [];
  readonly values: unknown[];
  constructor(initial: readonly unknown[]) {
    this.values = [...initial];
  }
  set(column: string, value: unknown, cast = ""): void {
    this.values.push(value);
    this.cols.push(`${column} = $${this.values.length}${cast}`);
  }
  get empty(): boolean {
    return this.cols.length === 0;
  }
  get clause(): string {
    return this.cols.join(", ");
  }
}
