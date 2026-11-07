// CRM around a customer: notes, follow-up tasks, communications log, timeline, outstanding balance.
import { z } from "zod";
import { AppError, ErrorCode, FollowUpOrigin, FollowUpStatus, instantSchema, PrincipalKind } from "@qenbel/shared";
import {
  SetBuilder, assertRef, cursorSchema, decodeCursor, idArg, iso, isoReq, limitSchema, notFound, op, paise, text, toPage, tsText,
  type EngineContext, type SqlClient,
} from "./common.ts";
import { insertNote } from "./customers.ts";

async function assertCustomer(sql: SqlClient, ctx: EngineContext, customerId: string): Promise<void> {
  const res = await sql.query("select 1 from customers where tenant_id = $1 and id = $2", [ctx.tenantId, customerId]);
  if (res.rows.length === 0) throw notFound("Customer");
}

// ---- notes -------------------------------------------------------------------------------------------

export interface NoteDto {
  id: string;
  customerId: string;
  authorUserId: string | null;
  body: string;
  createdAt: string;
}

interface NoteRow {
  id: string;
  customer_id: string;
  author_user_id: string | null;
  body: string;
  created_at: Date;
  created_c: string;
}

const toNote = (r: NoteRow): NoteDto => ({
  id: r.id, customerId: r.customer_id, authorUserId: r.author_user_id, body: r.body, createdAt: isoReq(r.created_at),
});

export const addCustomerNote = op(
  z.object({ customerId: idArg, body: text(1, 4000) }).strict(),
  async (sql, ctx, input): Promise<NoteDto> => {
    await assertCustomer(sql, ctx, input.customerId);
    const id = await insertNote(sql, ctx, input.customerId, input.body);
    const res = await sql.query<NoteRow>(
      `select id, customer_id, author_user_id, body, created_at, ${tsText("created_at")} as created_c from customer_notes where tenant_id = $1 and id = $2`,
      [ctx.tenantId, id],
    );
    return toNote(res.rows[0] as NoteRow);
  },
);

export const listCustomerNotes = op(
  z.object({ customerId: idArg, limit: limitSchema, cursor: cursorSchema }).strict(),
  async (sql, ctx, input) => {
    await assertCustomer(sql, ctx, input.customerId);
    const cur = decodeCursor(input.cursor, 2);
    const res = await sql.query<NoteRow>(
      `select id, customer_id, author_user_id, body, created_at, ${tsText("created_at")} as created_c
         from customer_notes
        where tenant_id = $1 and customer_id = $2 and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::uuid))
        order by created_at desc, id desc limit $5`,
      [ctx.tenantId, input.customerId, cur?.[0] ?? null, cur?.[1] ?? null, input.limit + 1],
    );
    const page = toPage(res.rows, input.limit, (r) => [r.created_c, r.id]);
    return { items: page.items.map(toNote), nextCursor: page.nextCursor };
  },
);

// ---- follow-up tasks ---------------------------------------------------------------------------------

export interface FollowUpDto {
  id: string;
  title: string;
  details: string | null;
  status: string;
  origin: string;
  customerId: string | null;
  bookingId: string | null;
  orderId: string | null;
  conversationId: string | null;
  assignedUserId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FollowUpRow {
  id: string;
  title: string;
  details: string | null;
  status: string;
  origin: string;
  customer_id: string | null;
  booking_id: string | null;
  order_id: string | null;
  conversation_id: string | null;
  assigned_user_id: string | null;
  due_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_c: string;
}

const FOLLOW_UP_COLS = `id, title, details, status, origin, customer_id, booking_id, order_id, conversation_id, assigned_user_id,
  due_at, completed_at, created_at, updated_at, ${tsText("created_at")} as created_c`;

const toFollowUp = (r: FollowUpRow): FollowUpDto => ({
  id: r.id, title: r.title, details: r.details, status: r.status, origin: r.origin,
  customerId: r.customer_id, bookingId: r.booking_id, orderId: r.order_id, conversationId: r.conversation_id,
  assignedUserId: r.assigned_user_id, dueAt: iso(r.due_at), completedAt: iso(r.completed_at),
  createdAt: isoReq(r.created_at), updatedAt: isoReq(r.updated_at),
});

const originSchema = z.enum(Object.values(FollowUpOrigin) as [string, ...string[]]);

function defaultOrigin(ctx: EngineContext): string {
  switch (ctx.actor.kind) {
    case PrincipalKind.API_CREDENTIAL:
      return FollowUpOrigin.AI_ESCALATION;
    case PrincipalKind.SYSTEM:
      return FollowUpOrigin.SYSTEM;
    default:
      return FollowUpOrigin.STAFF;
  }
}

async function loadFollowUp(sql: SqlClient, ctx: EngineContext, id: string): Promise<FollowUpDto> {
  const res = await sql.query<FollowUpRow>(`select ${FOLLOW_UP_COLS} from follow_up_tasks where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  const row = res.rows[0];
  if (!row) throw notFound("Follow-up task");
  return toFollowUp(row);
}

/** Create a follow-up. Origin defaults from the actor (user: staff, API credential: ai_escalation, system: system). */
export const createFollowUp = op(
  z
    .object({
      title: text(1, 300),
      details: text(1, 4000).optional(),
      customerId: idArg.optional(),
      bookingId: idArg.optional(),
      orderId: idArg.optional(),
      conversationId: idArg.optional(),
      dueAt: instantSchema.optional(),
      assignedUserId: idArg.optional(),
      origin: originSchema.optional(),
    })
    .strict(),
  async (sql, ctx, input): Promise<FollowUpDto> => {
    if (input.customerId) await assertRef(sql, ctx, "customers", input.customerId, "customerId");
    if (input.bookingId) await assertRef(sql, ctx, "bookings", input.bookingId, "bookingId");
    if (input.orderId) await assertRef(sql, ctx, "orders", input.orderId, "orderId");
    if (input.conversationId) await assertRef(sql, ctx, "conversations", input.conversationId, "conversationId");
    if (input.assignedUserId) await assertRef(sql, ctx, "users", input.assignedUserId, "assignedUserId");
    const res = await sql.query<{ id: string }>(
      `insert into follow_up_tasks (tenant_id, customer_id, booking_id, order_id, conversation_id, title, details, origin, due_at, assigned_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [
        ctx.tenantId, input.customerId ?? null, input.bookingId ?? null, input.orderId ?? null, input.conversationId ?? null,
        input.title, input.details ?? null, input.origin ?? defaultOrigin(ctx), input.dueAt ?? null, input.assignedUserId ?? null,
      ],
    );
    return loadFollowUp(sql, ctx, (res.rows[0] as { id: string }).id);
  },
);

export const getFollowUp = op(z.object({ followUpId: idArg }).strict(), (sql, ctx, input) => loadFollowUp(sql, ctx, input.followUpId));

export const updateFollowUp = op(
  z
    .object({
      followUpId: idArg,
      title: text(1, 300).optional(),
      details: text(1, 4000).nullable().optional(),
      dueAt: instantSchema.nullable().optional(),
      assignedUserId: idArg.nullable().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 1, "Provide at least one field to change"),
  async (sql, ctx, input): Promise<FollowUpDto> => {
    if (input.assignedUserId) await assertRef(sql, ctx, "users", input.assignedUserId, "assignedUserId");
    const set = new SetBuilder([ctx.tenantId, input.followUpId]);
    if (input.title !== undefined) set.set("title", input.title);
    if (input.details !== undefined) set.set("details", input.details);
    if (input.dueAt !== undefined) set.set("due_at", input.dueAt);
    if (input.assignedUserId !== undefined) set.set("assigned_user_id", input.assignedUserId);
    const res = await sql.query(`update follow_up_tasks set ${set.clause} where tenant_id = $1 and id = $2 returning id`, set.values);
    if (res.rows.length === 0) throw notFound("Follow-up task");
    return loadFollowUp(sql, ctx, input.followUpId);
  },
);

/** open -> done | cancelled, and done | cancelled -> open (reopen). Setting the current status is a no-op. */
export const setFollowUpStatus = op(
  z.object({ followUpId: idArg, status: z.enum(Object.values(FollowUpStatus) as [string, ...string[]]) }).strict(),
  async (sql, ctx, input): Promise<FollowUpDto> => {
    const cur = await sql.query<{ status: string }>("select status from follow_up_tasks where tenant_id = $1 and id = $2 for update", [ctx.tenantId, input.followUpId]);
    const row = cur.rows[0];
    if (!row) throw notFound("Follow-up task");
    if (row.status === input.status) return loadFollowUp(sql, ctx, input.followUpId);
    const allowed = row.status === FollowUpStatus.OPEN || input.status === FollowUpStatus.OPEN;
    if (!allowed) throw new AppError(ErrorCode.INVALID_TRANSITION, "Reopen the task before changing it again.", { from: row.status, to: input.status });
    await sql.query(
      "update follow_up_tasks set status = $3, completed_at = $4 where tenant_id = $1 and id = $2",
      [ctx.tenantId, input.followUpId, input.status, input.status === FollowUpStatus.DONE ? ctx.now() : null],
    );
    return loadFollowUp(sql, ctx, input.followUpId);
  },
);

export const listFollowUps = op(
  z
    .object({
      status: z.enum(Object.values(FollowUpStatus) as [string, ...string[]]).optional(),
      origin: originSchema.optional(),
      customerId: idArg.optional(),
      assignedUserId: idArg.optional(),
      dueBefore: instantSchema.optional(),
      limit: limitSchema,
      cursor: cursorSchema,
    })
    .strict(),
  async (sql, ctx, input) => {
    const cur = decodeCursor(input.cursor, 2);
    const where = ["tenant_id = $1"];
    const params: unknown[] = [ctx.tenantId];
    const add = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    if (input.status) where.push(`status = ${add(input.status)}`);
    if (input.origin) where.push(`origin = ${add(input.origin)}`);
    if (input.customerId) where.push(`customer_id = ${add(input.customerId)}`);
    if (input.assignedUserId) where.push(`assigned_user_id = ${add(input.assignedUserId)}`);
    if (input.dueBefore) where.push(`due_at is not null and due_at <= ${add(input.dueBefore)}::timestamptz`);
    if (cur) where.push(`(created_at, id) < (${add(cur[0])}::timestamptz, ${add(cur[1])}::uuid)`);
    const limitP = add(input.limit + 1);
    const res = await sql.query<FollowUpRow>(
      `select ${FOLLOW_UP_COLS} from follow_up_tasks where ${where.join(" and ")} order by created_at desc, id desc limit ${limitP}`,
      params,
    );
    const page = toPage(res.rows, input.limit, (r) => [r.created_c, r.id]);
    return { items: page.items.map(toFollowUp), nextCursor: page.nextCursor };
  },
);

// ---- communications log ------------------------------------------------------------------------------

export interface CommunicationDto {
  id: string;
  customerId: string;
  direction: string;
  channel: string;
  subject: string | null;
  body: string | null;
  conversationId: string | null;
  bookingId: string | null;
  orderId: string | null;
  occurredAt: string;
}

interface CommunicationRow {
  id: string;
  customer_id: string;
  direction: string;
  channel: string;
  subject: string | null;
  body: string | null;
  conversation_id: string | null;
  booking_id: string | null;
  order_id: string | null;
  occurred_at: Date;
  occurred_c: string;
}

const COMM_COLS = `id, customer_id, direction, channel, subject, body, conversation_id, booking_id, order_id, occurred_at, ${tsText("occurred_at")} as occurred_c`;

const toCommunication = (r: CommunicationRow): CommunicationDto => ({
  id: r.id, customerId: r.customer_id, direction: r.direction, channel: r.channel, subject: r.subject, body: r.body,
  conversationId: r.conversation_id, bookingId: r.booking_id, orderId: r.order_id, occurredAt: isoReq(r.occurred_at),
});

const commChannel = z.enum(["web_chat", "whatsapp", "voice", "api", "dashboard", "email", "sms"]);

export const logCommunication = op(
  z
    .object({
      customerId: idArg,
      direction: z.enum(["inbound", "outbound"]),
      channel: commChannel,
      subject: text(1, 300).optional(),
      body: text(1, 10000).optional(),
      conversationId: idArg.optional(),
      bookingId: idArg.optional(),
      orderId: idArg.optional(),
      occurredAt: instantSchema.optional(),
    })
    .strict()
    .refine((v) => v.subject !== undefined || v.body !== undefined, "Provide a subject or a body"),
  async (sql, ctx, input): Promise<CommunicationDto> => {
    await assertCustomer(sql, ctx, input.customerId);
    if (input.conversationId) await assertRef(sql, ctx, "conversations", input.conversationId, "conversationId");
    if (input.bookingId) await assertRef(sql, ctx, "bookings", input.bookingId, "bookingId");
    if (input.orderId) await assertRef(sql, ctx, "orders", input.orderId, "orderId");
    const res = await sql.query<CommunicationRow>(
      `insert into communications (tenant_id, customer_id, direction, channel, subject, body, conversation_id, booking_id, order_id, created_by_user_id, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, (select id from users where tenant_id = $1 and id::text = $10 and $11::text = 'user'), $12)
       returning ${COMM_COLS}`,
      [
        ctx.tenantId, input.customerId, input.direction, input.channel, input.subject ?? null, input.body ?? null,
        input.conversationId ?? null, input.bookingId ?? null, input.orderId ?? null, ctx.actor.id, ctx.actor.kind,
        input.occurredAt ?? ctx.now(),
      ],
    );
    return toCommunication(res.rows[0] as CommunicationRow);
  },
);

export const listCommunications = op(
  z.object({ customerId: idArg, limit: limitSchema, cursor: cursorSchema }).strict(),
  async (sql, ctx, input) => {
    await assertCustomer(sql, ctx, input.customerId);
    const cur = decodeCursor(input.cursor, 2);
    const res = await sql.query<CommunicationRow>(
      `select ${COMM_COLS} from communications
        where tenant_id = $1 and customer_id = $2 and ($3::timestamptz is null or (occurred_at, id) < ($3::timestamptz, $4::uuid))
        order by occurred_at desc, id desc limit $5`,
      [ctx.tenantId, input.customerId, cur?.[0] ?? null, cur?.[1] ?? null, input.limit + 1],
    );
    const page = toPage(res.rows, input.limit, (r) => [r.occurred_c, r.id]);
    return { items: page.items.map(toCommunication), nextCursor: page.nextCursor };
  },
);

// ---- timeline ----------------------------------------------------------------------------------------

export const TIMELINE_KINDS = ["booking", "order", "communication", "note", "follow_up"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineEntry {
  kind: TimelineKind;
  id: string;
  /** Booking: start time. Order: created. Others: when it happened. */
  at: string;
  status: string | null;
  reference: string | null;
  summary: string;
  /** Orders only: total in integer paise. */
  amountPaise: number | null;
  currency: string | null;
}

interface TimelineRow {
  kind: TimelineKind;
  id: string;
  at: Date;
  at_c: string;
  status: string | null;
  reference: string | null;
  summary: string | null;
  amount_paise: string | null;
  currency: string | null;
}

/**
 * Newest-first activity for one customer: bookings, orders, communications, notes and follow-ups, by read-only
 * joins. Communication bodies and note text are not included (summary is the subject/channel/first 120 chars).
 */
export const getCustomerTimeline = op(
  z
    .object({
      customerId: idArg,
      kinds: z.array(z.enum(TIMELINE_KINDS)).min(1).max(5).optional(),
      limit: limitSchema,
      cursor: cursorSchema,
    })
    .strict(),
  async (sql, ctx, input) => {
    await assertCustomer(sql, ctx, input.customerId);
    const cur = decodeCursor(input.cursor, 2);
    const kinds = input.kinds ?? [...TIMELINE_KINDS];
    const res = await sql.query<TimelineRow>(
      `select kind, id, at, ${tsText("at")} as at_c, status, reference, summary, amount_paise, currency from (
         select 'booking'::text as kind, b.id, b.starts_at as at, b.status::text as status, b.reference::text as reference,
                coalesce(ci.name, 'Booking')::text as summary, null::bigint as amount_paise, b.currency::text as currency
           from bookings b left join catalogue_items ci on ci.tenant_id = b.tenant_id and ci.id = b.catalogue_item_id
          where b.tenant_id = $1 and b.customer_id = $2
         union all
         select 'order', o.id, o.created_at, o.status, o.reference, 'Order ' || o.reference, o.total_paise, o.currency::text
           from orders o where o.tenant_id = $1 and o.customer_id = $2
         union all
         select 'communication', m.id, m.occurred_at, m.direction, null, coalesce(m.subject, m.channel), null, null
           from communications m where m.tenant_id = $1 and m.customer_id = $2
         union all
         select 'note', n.id, n.created_at, null, null, left(n.body, 120), null, null
           from customer_notes n where n.tenant_id = $1 and n.customer_id = $2
         union all
         select 'follow_up', f.id, f.created_at, f.status, null, f.title, null, null
           from follow_up_tasks f where f.tenant_id = $1 and f.customer_id = $2
       ) t
       where t.kind = any($3::text[]) and ($4::timestamptz is null or (t.at, t.id) < ($4::timestamptz, $5::uuid))
       order by t.at desc, t.id desc limit $6`,
      [ctx.tenantId, input.customerId, kinds, cur?.[0] ?? null, cur?.[1] ?? null, input.limit + 1],
    );
    const page = toPage(res.rows, input.limit, (r) => [r.at_c, r.id]);
    const items: TimelineEntry[] = page.items.map((r) => ({
      kind: r.kind,
      id: r.id,
      at: isoReq(r.at),
      status: r.status,
      reference: r.reference,
      summary: r.summary ?? "",
      amountPaise: r.amount_paise === null ? null : paise(r.amount_paise),
      currency: r.currency,
    }));
    return { items, nextCursor: page.nextCursor };
  },
);

// ---- outstanding balance -----------------------------------------------------------------------------

export interface BalanceLine {
  currency: string;
  /** Placed-or-later orders not yet fully paid: sum of max(total - net payments, 0) per order. */
  ordersOutstandingPaise: number;
  /** Deposits on live or finished bookings not yet fully paid. */
  depositsOutstandingPaise: number;
  totalOutstandingPaise: number;
}

/**
 * What this customer still owes, per currency, from the payments ledger. Read only.
 * Orders count once PLACED (not DRAFT, CANCELLED, REJECTED, REFUNDED). Net payment = completed payments minus
 * completed refunds on that order. Overpaying one order never offsets another. Booking deposits use
 * payments recorded against the booking with no order.
 */
export const getCustomerBalance = op(z.object({ customerId: idArg }).strict(), async (sql, ctx, input) => {
  await assertCustomer(sql, ctx, input.customerId);
  const res = await sql.query<{ currency: string; orders_due: string; deposits_due: string }>(
    `with ord as (
       select o.currency::text as currency,
              greatest(o.total_paise - coalesce((select sum(case p.kind when 'payment' then p.amount_paise else -p.amount_paise end)
                                                   from payments p
                                                  where p.tenant_id = o.tenant_id and p.order_id = o.id and p.status = 'completed'), 0), 0) as due
         from orders o
        where o.tenant_id = $1 and o.customer_id = $2 and o.status in ('PLACED', 'ACCEPTED', 'PROCESSING', 'READY', 'FULFILLED')
     ), dep as (
       select b.currency::text as currency,
              greatest(b.deposit_paise - coalesce((select sum(case p.kind when 'payment' then p.amount_paise else -p.amount_paise end)
                                                     from payments p
                                                    where p.tenant_id = b.tenant_id and p.booking_id = b.id and p.order_id is null and p.status = 'completed'), 0), 0) as due
         from bookings b
        where b.tenant_id = $1 and b.customer_id = $2 and b.deposit_paise > 0 and b.status in ('CONFIRMED', 'CHECKED_IN', 'COMPLETED')
     )
     select c.currency,
            coalesce((select sum(due) from ord where ord.currency = c.currency), 0) as orders_due,
            coalesce((select sum(due) from dep where dep.currency = c.currency), 0) as deposits_due
       from (select currency from ord union select currency from dep) c
      order by c.currency`,
    [ctx.tenantId, input.customerId],
  );
  const balances: BalanceLine[] = res.rows.map((r) => {
    const o = paise(r.orders_due);
    const d = paise(r.deposits_due);
    return { currency: r.currency, ordersOutstandingPaise: o, depositsOutstandingPaise: d, totalOutstandingPaise: o + d };
  });
  return { customerId: input.customerId, balances };
});
