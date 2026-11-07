// Customers (CRM core): create with dedupe, update, archive/restore, search (staff and AI variants), tags.
import { z } from "zod";
import { AppError, Channel, ErrorCode, localDateSchema, WebhookEvent } from "@qenbel/shared";
import {
  CONTACT_UNIQUE_FIELDS, SetBuilder, isStaffChannel, subjectCustomerId, count, cursorSchema, decodeCursor, emitEvent, idArg, iso, isContactUnique, isoReq, likeEscape, limitSchema, lockKeys, notFound, op, staffOp,
  text, toPage, withSavepoint, type EngineContext, type SqlClient,
} from "./common.ts";
import { maskEmail, maskPhone, normaliseEmail, normalisePhone } from "./phone.ts";

// ---- schemas -----------------------------------------------------------------------------------------

export const phoneInput = z
  .string()
  .max(40)
  .transform((v, ctx) => {
    const n = normalisePhone(v);
    if (n === null) {
      ctx.addIssue({ code: "custom", message: "Enter a phone number with country code, or a 10 digit Indian mobile number" });
      return z.NEVER;
    }
    return n;
  });

export const emailInput = z
  .string()
  .max(320)
  .transform((v, ctx) => {
    const n = normaliseEmail(v);
    if (n === null) {
      ctx.addIssue({ code: "custom", message: "Enter a valid email address" });
      return z.NEVER;
    }
    return n;
  });

const RESERVED_ATTRIBUTES = ["dateOfBirth", "address"];

/** Pack-defined extra fields (for example allergies). Plain values only. A null value removes the key. */
const attributesInput = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.union([text(0, 500), z.number().finite(), z.boolean(), z.null()]))
  .refine((r) => Object.keys(r).length <= 20, "At most 20 attributes")
  .refine((r) => !Object.keys(r).some((k) => RESERVED_ATTRIBUTES.includes(k)), "dateOfBirth and address have their own fields");

const tagInput = text(1, 60).transform((v) => v.toLowerCase());
const sourceInput = z.enum(Object.values(Channel) as [string, ...string[]]);

const createCustomerInput = z
  .object({
    name: text(1, 120),
    phone: phoneInput.optional(),
    email: emailInput.optional(),
    dateOfBirth: localDateSchema.optional(),
    address: text(1, 300).optional(),
    notes: text(1, 4000).optional(),
    attributes: attributesInput.optional(),
    tags: z.array(tagInput).max(20).optional(),
    consentMarketing: z.boolean().optional(),
    source: sourceInput.optional(),
  })
  .strict();

const updateCustomerInput = z
  .object({
    customerId: idArg,
    name: text(1, 120).optional(),
    phone: phoneInput.nullable().optional(),
    email: emailInput.nullable().optional(),
    dateOfBirth: localDateSchema.nullable().optional(),
    address: text(1, 300).nullable().optional(),
    attributes: attributesInput.optional(),
    consentMarketing: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, "Provide at least one field to change");

const customerIdInput = z.object({ customerId: idArg }).strict();

const searchCustomersInput = z
  .object({
    query: text(1, 120).optional(),
    phone: phoneInput.optional(),
    email: emailInput.optional(),
    tag: tagInput.optional(),
    archived: z.enum(["exclude", "include", "only"]).default("exclude"),
    limit: limitSchema,
    cursor: cursorSchema,
  })
  .strict();

const searchCustomersForAiInput = z
  .object({
    phone: phoneInput.optional(),
    email: emailInput.optional(),
    name: text(2, 120).optional(),
    limit: z.number().int().min(1).max(5).default(3),
  })
  .strict()
  .refine((v) => v.phone !== undefined || v.email !== undefined || v.name !== undefined, "Give a phone, email or name");

// ---- DTOs --------------------------------------------------------------------------------------------

export interface CustomerDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  dateOfBirth: string | null;
  address: string | null;
  attributes: Record<string, string | number | boolean>;
  tags: string[];
  source: string | null;
  consentMarketing: boolean;
  consentUpdatedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What an AI tool may see. No full phone, no full email, no notes, no history. */
export interface CustomerAiSummary {
  customerId: string;
  displayName: string;
  phoneMasked: string | null;
  emailMasked: string | null;
  hasUpcomingBooking: boolean;
}

export interface CreateCustomerResult {
  customer: CustomerDto;
  created: boolean;
  matchedBy: "phone" | "email" | null;
}

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: string | null;
  attributes: Record<string, unknown> | null;
  consent_marketing: boolean;
  consent_updated_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  tags: string[] | null;
  name_key?: string;
}

const CUSTOMER_COLS = `c.id, c.name, c.phone, c.email, c.source, c.attributes, c.consent_marketing, c.consent_updated_at,
  c.archived_at, c.created_at, c.updated_at,
  coalesce((select array_agg(t.tag order by t.tag) from customer_tags t where t.tenant_id = c.tenant_id and t.customer_id = c.id), '{}') as tags`;

function toCustomer(row: CustomerRow): CustomerDto {
  const attrs = { ...(row.attributes ?? {}) } as Record<string, unknown>;
  const dob = typeof attrs.dateOfBirth === "string" ? attrs.dateOfBirth : null;
  const address = typeof attrs.address === "string" ? attrs.address : null;
  delete attrs.dateOfBirth;
  delete attrs.address;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    dateOfBirth: dob,
    address,
    attributes: attrs as Record<string, string | number | boolean>,
    tags: row.tags ?? [],
    source: row.source,
    consentMarketing: row.consent_marketing,
    consentUpdatedAt: iso(row.consent_updated_at),
    archivedAt: iso(row.archived_at),
    createdAt: isoReq(row.created_at),
    updatedAt: isoReq(row.updated_at),
  };
}

async function loadCustomer(sql: SqlClient, ctx: EngineContext, id: string): Promise<CustomerDto> {
  const res = await sql.query<CustomerRow>(`select ${CUSTOMER_COLS} from customers c where c.tenant_id = $1 and c.id = $2`, [ctx.tenantId, id]);
  const row = res.rows[0];
  if (!row) throw notFound("Customer");
  return toCustomer(row);
}

function contactLockKeys(phone: string | null | undefined, email: string | null | undefined): string[] {
  const keys: string[] = [];
  if (phone) keys.push(`customer:phone:${phone}`);
  if (email) keys.push(`customer:email:${email}`);
  return keys;
}

interface Match {
  id: string;
  by: "phone" | "email";
}

/** Active (not archived) customers sharing a phone or email, excluding `exceptId`. */
async function findMatches(
  sql: SqlClient, ctx: EngineContext, phone: string | null | undefined, email: string | null | undefined, exceptId?: string,
): Promise<Match[]> {
  if (!phone && !email) return [];
  const res = await sql.query<{ id: string; by_phone: boolean; by_email: boolean }>(
    `select id, ($2::text is not null and phone = $2) as by_phone, ($3::text is not null and lower(email) = $3) as by_email
       from customers
      where tenant_id = $1 and archived_at is null and ($4::uuid is null or id <> $4)
        and (($2::text is not null and phone = $2) or ($3::text is not null and lower(email) = $3))
      order by created_at, id`,
    [ctx.tenantId, phone ?? null, email ?? null, exceptId ?? null],
  );
  const out: Match[] = [];
  for (const r of res.rows) {
    if (r.by_phone) out.push({ id: r.id, by: "phone" });
    if (r.by_email) out.push({ id: r.id, by: "email" });
  }
  return out;
}

/** The CONFLICT for a database unique violation on phone or email, naming the field and the customers that hold the value. */
function contactConflict(err: unknown, candidateIds: readonly string[]): AppError {
  const field = CONTACT_UNIQUE_FIELDS[(err as { constraint: string }).constraint] as "phone" | "email";
  return new AppError(ErrorCode.CONFLICT, `Another customer already has this ${field === "phone" ? "phone number" : "email address"}.`, {
    field,
    ...(candidateIds.length === 1 ? { customerId: candidateIds[0] } : {}),
    candidates: [...candidateIds],
  });
}

// ---- create / update / archive -----------------------------------------------------------------------

/**
 * Create a customer, or return the existing active one with the same normalised phone or email (R4.2).
 * Two different existing customers matching (one by phone, one by email) is ambiguous: CONFLICT listing both,
 * so staff can choose. Concurrent creates of the same phone/email are serialised by advisory locks.
 * Writes `customer.created` to the outbox only when a row is actually created.
 */
export const createCustomer = staffOp(createCustomerInput, async (sql, ctx, input): Promise<CreateCustomerResult> => {
  await lockKeys(sql, ctx, contactLockKeys(input.phone, input.email));
  const matches = await findMatches(sql, ctx, input.phone, input.email);
  if (matches.length > 0) {
    const ids = [...new Set(matches.map((m) => m.id))];
    if (ids.length > 1) {
      throw new AppError(ErrorCode.CONFLICT, "More than one existing customer matches. Choose which one to use.", { candidates: ids });
    }
    const first = matches[0] as Match;
    return { customer: await loadCustomer(sql, ctx, first.id), created: false, matchedBy: matches.some((m) => m.by === "phone") ? "phone" : "email" };
  }

  const attrs: Record<string, unknown> = { ...(input.attributes ?? {}) };
  for (const k of Object.keys(attrs)) if (attrs[k] === null) delete attrs[k];
  if (input.dateOfBirth !== undefined) attrs.dateOfBirth = input.dateOfBirth;
  if (input.address !== undefined) attrs.address = input.address;

  const now = ctx.now();
  let id: string;
  try {
    // Savepoint: the database also enforces unique active phone / lower(email) (014). A writer that does not take our
    // advisory locks can still win a race; then we re-read and answer as a dedupe instead of failing the transaction.
    const ins = await withSavepoint(sql, () =>
      sql.query<{ id: string }>(
        `insert into customers (tenant_id, name, phone, email, source, attributes, consent_marketing, consent_updated_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) returning id`,
        [
          ctx.tenantId, input.name, input.phone ?? null, input.email ?? null, input.source ?? ctx.actor.channel,
          JSON.stringify(attrs), input.consentMarketing ?? false, input.consentMarketing === undefined ? null : now,
        ],
      ),
    );
    id = (ins.rows[0] as { id: string }).id;
  } catch (err) {
    if (!isContactUnique(err)) throw err;
    const raced = await findMatches(sql, ctx, input.phone, input.email);
    const ids = [...new Set(raced.map((m) => m.id))];
    if (ids.length === 1) {
      return { customer: await loadCustomer(sql, ctx, ids[0] as string), created: false, matchedBy: raced.some((m) => m.by === "phone") ? "phone" : "email" };
    }
    throw contactConflict(err, ids);
  }

  for (const tag of new Set(input.tags ?? [])) {
    await sql.query("insert into customer_tags (tenant_id, customer_id, tag) values ($1, $2, $3)", [ctx.tenantId, id, tag]);
  }
  if (input.notes !== undefined) await insertNote(sql, ctx, id, input.notes);

  const customer = await loadCustomer(sql, ctx, id);
  await emitEvent(sql, ctx, {
    type: WebhookEvent.CUSTOMER_CREATED,
    aggregateType: "customer",
    aggregateId: id,
    payload: {
      customerId: id,
      name: customer.name,
      phoneMasked: maskPhone(customer.phone),
      emailMasked: maskEmail(customer.email),
      source: customer.source,
      createdAt: customer.createdAt,
    },
  });
  return { customer, created: true, matchedBy: null };
});

export async function insertNote(sql: SqlClient, ctx: EngineContext, customerId: string, body: string): Promise<string> {
  const res = await sql.query<{ id: string }>(
    `insert into customer_notes (tenant_id, customer_id, author_user_id, body)
     values ($1, $2, (select id from users where tenant_id = $1 and id::text = $3 and $4::text = 'user'), $5) returning id`,
    [ctx.tenantId, customerId, ctx.actor.id, ctx.actor.kind, body],
  );
  return (res.rows[0] as { id: string }).id;
}

export const updateCustomer = staffOp(updateCustomerInput, async (sql, ctx, input): Promise<CustomerDto> => {
  const cur = await sql.query<CustomerRow>(
    "select id, name, phone, email, attributes, archived_at from customers where tenant_id = $1 and id = $2 for update",
    [ctx.tenantId, input.customerId],
  );
  const row = cur.rows[0];
  if (!row) throw notFound("Customer");
  if (row.archived_at) throw new AppError(ErrorCode.CONFLICT, "Restore this customer before changing it.");

  const newPhone = input.phone === undefined ? row.phone : input.phone;
  const newEmail = input.email === undefined ? row.email : input.email;
  await lockKeys(sql, ctx, contactLockKeys(newPhone, newEmail));
  const matches = await findMatches(sql, ctx, input.phone === undefined ? null : input.phone, input.email === undefined ? null : input.email, input.customerId);
  if (matches.length > 0) {
    const m = matches[0] as Match;
    throw new AppError(ErrorCode.CONFLICT, `Another customer already has this ${m.by === "phone" ? "phone number" : "email address"}.`, {
      field: m.by,
      customerId: m.id,
      candidates: [...new Set(matches.map((x) => x.id))],
    });
  }

  const attrs: Record<string, unknown> = { ...(row.attributes ?? {}) };
  if (input.attributes) {
    for (const [k, v] of Object.entries(input.attributes)) {
      if (v === null) delete attrs[k];
      else attrs[k] = v;
    }
  }
  if (input.dateOfBirth !== undefined) {
    if (input.dateOfBirth === null) delete attrs.dateOfBirth;
    else attrs.dateOfBirth = input.dateOfBirth;
  }
  if (input.address !== undefined) {
    if (input.address === null) delete attrs.address;
    else attrs.address = input.address;
  }

  const set = new SetBuilder([ctx.tenantId, input.customerId]);
  if (input.name !== undefined) set.set("name", input.name);
  if (input.phone !== undefined) set.set("phone", input.phone);
  if (input.email !== undefined) set.set("email", input.email);
  if (input.consentMarketing !== undefined) {
    set.set("consent_marketing", input.consentMarketing);
    set.set("consent_updated_at", ctx.now());
  }
  set.set("attributes", JSON.stringify(attrs), "::jsonb");
  try {
    await withSavepoint(sql, () => sql.query(`update customers set ${set.clause} where tenant_id = $1 and id = $2`, set.values));
  } catch (err) {
    if (!isContactUnique(err)) throw err;
    const raced = await findMatches(sql, ctx, input.phone === undefined ? null : input.phone, input.email === undefined ? null : input.email, input.customerId);
    throw contactConflict(err, [...new Set(raced.map((m) => m.id))]);
  }
  return loadCustomer(sql, ctx, input.customerId);
});

/** Soft delete. Idempotent: archiving an archived customer returns it unchanged. History stays linked. */
export const archiveCustomer = staffOp(customerIdInput, async (sql, ctx, input): Promise<CustomerDto> => {
  const res = await sql.query(
    "update customers set archived_at = coalesce(archived_at, $3) where tenant_id = $1 and id = $2 returning id",
    [ctx.tenantId, input.customerId, ctx.now()],
  );
  if (res.rows.length === 0) throw notFound("Customer");
  return loadCustomer(sql, ctx, input.customerId);
});

/** Undo archive. Refused if another active customer now has the same phone or email. */
export const restoreCustomer = staffOp(customerIdInput, async (sql, ctx, input): Promise<CustomerDto> => {
  const cur = await sql.query<CustomerRow>("select id, phone, email, archived_at from customers where tenant_id = $1 and id = $2 for update", [ctx.tenantId, input.customerId]);
  const row = cur.rows[0];
  if (!row) throw notFound("Customer");
  if (!row.archived_at) return loadCustomer(sql, ctx, input.customerId);
  await lockKeys(sql, ctx, contactLockKeys(row.phone, row.email));
  const matches = await findMatches(sql, ctx, row.phone, row.email, input.customerId);
  if (matches.length > 0) {
    const m = matches[0] as Match;
    throw new AppError(ErrorCode.CONFLICT, "Another customer now has this phone number or email address.", {
      field: m.by,
      customerId: m.id,
      candidates: [...new Set(matches.map((x) => x.id))],
    });
  }
  try {
    await withSavepoint(sql, () => sql.query("update customers set archived_at = null where tenant_id = $1 and id = $2", [ctx.tenantId, input.customerId]));
  } catch (err) {
    if (!isContactUnique(err)) throw err;
    const raced = await findMatches(sql, ctx, row.phone, row.email, input.customerId);
    throw contactConflict(err, [...new Set(raced.map((m) => m.id))]);
  }
  return loadCustomer(sql, ctx, input.customerId);
});

export const getCustomer = staffOp(customerIdInput, async (sql, ctx, input): Promise<CustomerDto> => loadCustomer(sql, ctx, input.customerId));

// ---- search ------------------------------------------------------------------------------------------

/**
 * Staff search: full records. `query` matches name or email (partial) and phone (digits, partial).
 * `phone` and `email` are exact matches on the normalised value. No filters lists everyone (paged, by name).
 */
export const searchCustomers = staffOp(searchCustomersInput, async (sql, ctx, input) => {
  const cur = decodeCursor(input.cursor, 2);
  const where: string[] = ["c.tenant_id = $1"];
  const params: unknown[] = [ctx.tenantId];
  const add = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  if (input.archived === "exclude") where.push("c.archived_at is null");
  if (input.archived === "only") where.push("c.archived_at is not null");
  if (input.phone) where.push(`c.phone = ${add(input.phone)}`);
  if (input.email) where.push(`lower(c.email) = ${add(input.email)}`);
  if (input.tag) {
    where.push(`exists (select 1 from customer_tags t where t.tenant_id = c.tenant_id and t.customer_id = c.id and t.tag = ${add(input.tag)})`);
  }
  if (input.query) {
    const like = `%${likeEscape(input.query.toLowerCase())}%`;
    const digits = input.query.replace(/[^0-9]/g, "");
    const parts = [`lower(c.name) like ${add(like)} escape '\\'`, `lower(c.email) like ${add(like)} escape '\\'`];
    if (digits.length >= 3) parts.push(`c.phone like ${add(`%${digits}%`)}`);
    where.push(`(${parts.join(" or ")})`);
  }
  if (cur) where.push(`(lower(c.name), c.id) > (${add(cur[0])}, ${add(cur[1])}::uuid)`);
  const limitP = add(input.limit + 1);
  const res = await sql.query<CustomerRow>(
    `select ${CUSTOMER_COLS}, lower(c.name) as name_key from customers c
      where ${where.join(" and ")} order by lower(c.name), c.id limit ${limitP}`,
    params,
  );
  const page = toPage(res.rows, input.limit, (r) => [r.name_key as string, r.id]);
  return { items: page.items.map(toCustomer), nextCursor: page.nextCursor };
});

/**
 * AI-facing customer lookup: minimal fields only, at most 5 results, never lists everyone. Phone and email are exact
 * matches; name is a partial match. Archived customers are never returned. Display name is the first name.
 *
 * Two modes, chosen by the channel in `ctx` (never by input):
 *  - Trusted channels (dashboard, api): a tenant-wide lookup of the minimal summaries above.
 *  - Customer channels (web_chat, whatsapp, voice, and any value outside the Channel enum): NOT a lookup. It can
 *    only confirm the customer the channel layer verified (`ctx.subject.customerId`): the filters given must all match
 *    that one record, and the only possible result is that record's own minimal summary. Another customer's id, name
 *    fragment, masked contact or booking flag is unreachable (the query is bound to the subject's id). Without a
 *    verified subject, or when nothing matches, the answer is the same empty list: no error and no SQL on the
 *    no-subject path, so nothing can be learnt about who is a customer.
 */
export const searchCustomersForAi = op(searchCustomersForAiInput, async (sql, ctx, input): Promise<{ customers: CustomerAiSummary[] }> => {
  const staff = isStaffChannel(ctx);
  const subject = subjectCustomerId(ctx);
  if (!staff && subject === null) return { customers: [] };
  const where: string[] = ["c.tenant_id = $1", "c.archived_at is null"];
  const params: unknown[] = [ctx.tenantId, ctx.now()];
  const add = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  if (!staff) where.push(`c.id = ${add(subject)}::uuid`);
  if (input.phone) where.push(`c.phone = ${add(input.phone)}`);
  if (input.email) where.push(`lower(c.email) = ${add(input.email)}`);
  if (input.name) where.push(`lower(c.name) like ${add(`%${likeEscape(input.name.toLowerCase())}%`)} escape '\\'`);
  const limitP = add(input.limit);
  const res = await sql.query<{ id: string; name: string; phone: string | null; email: string | null; upcoming: boolean }>(
    `select c.id, c.name, c.phone, c.email,
            exists (select 1 from bookings b
                     where b.tenant_id = c.tenant_id and b.customer_id = c.id and b.ends_at > $2
                       and (b.status in ('CONFIRMED', 'CHECKED_IN') or (b.status = 'HOLD' and b.hold_expires_at > $2))) as upcoming
       from customers c where ${where.join(" and ")} order by lower(c.name), c.id limit ${limitP}`,
    params,
  );
  return {
    customers: res.rows.map((r) => ({
      customerId: r.id,
      displayName: (r.name.trim().split(/\s+/)[0] ?? "").slice(0, 120),
      phoneMasked: maskPhone(r.phone),
      emailMasked: maskEmail(r.email),
      hasUpcomingBooking: r.upcoming,
    })),
  };
});

// ---- tags --------------------------------------------------------------------------------------------

const tagArgs = z.object({ customerId: idArg, tag: tagInput }).strict();
const MAX_TAGS_PER_CUSTOMER = 50;

export const addCustomerTag = staffOp(tagArgs, async (sql, ctx, input): Promise<CustomerDto> => {
  const own = await sql.query<{ n: string }>(
    "select (select count(*) from customer_tags where tenant_id = $1 and customer_id = $2) as n from customers where tenant_id = $1 and id = $2 for update",
    [ctx.tenantId, input.customerId],
  );
  if (own.rows.length === 0) throw notFound("Customer");
  if (count((own.rows[0] as { n: string }).n) >= MAX_TAGS_PER_CUSTOMER) {
    throw new AppError(ErrorCode.CONFLICT, `A customer can have at most ${MAX_TAGS_PER_CUSTOMER} tags.`);
  }
  await sql.query(
    "insert into customer_tags (tenant_id, customer_id, tag) values ($1, $2, $3) on conflict (tenant_id, customer_id, tag) do nothing",
    [ctx.tenantId, input.customerId, input.tag],
  );
  return loadCustomer(sql, ctx, input.customerId);
});

export const removeCustomerTag = staffOp(tagArgs, async (sql, ctx, input): Promise<CustomerDto> => {
  const exists = await sql.query("select 1 from customers where tenant_id = $1 and id = $2", [ctx.tenantId, input.customerId]);
  if (exists.rows.length === 0) throw notFound("Customer");
  await sql.query("delete from customer_tags where tenant_id = $1 and customer_id = $2 and tag = $3", [ctx.tenantId, input.customerId, input.tag]);
  return loadCustomer(sql, ctx, input.customerId);
});

/** Distinct tags in use in this tenant with their counts (active customers only). */
export const listTags = staffOp(z.object({}).strict(), async (sql, ctx) => {
  const res = await sql.query<{ tag: string; n: string }>(
    `select t.tag, count(*) as n from customer_tags t join customers c on c.tenant_id = t.tenant_id and c.id = t.customer_id
      where t.tenant_id = $1 and c.archived_at is null group by t.tag order by t.tag limit 500`,
    [ctx.tenantId],
  );
  return res.rows.map((r) => ({ tag: r.tag, customers: count(r.n) }));
});
