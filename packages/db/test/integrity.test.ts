import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { withTenant } from "../src/index.ts";
import {
  BookingStatus, Channel, OrderStatus, PaymentStatus, PrincipalKind, ResourceType, ToolName, ToolPermissionLevel, UserRole, WebhookEvent,
} from "../../shared/src/enums.ts";
import { at, attempt, baseFixture, connectTestDb, createTenant, insertRow, type TestDb } from "./helpers.ts";

// (d) audit_log append-only, (e) idempotency unique constraint, (f) CHECK constraints, plus enum drift.

let db: TestDb;
let T: string;
let T2: string;

before(async () => {
  db = await connectTestDb();
  T = await createTenant(db, "integrity");
  T2 = await createTenant(db, "integrity2");
});
after(async () => {
  await db.close();
});

const values = (o: Record<string, string>) => Object.values(o).sort();

describe("(d) audit_log is append-only", () => {
  let auditId: string;
  before(async () => {
    auditId = await withTenant(db.app, T, (c) =>
      insertRow(c, "audit_log", { tenant_id: T, actor_kind: "user", actor_id: "u1", action: "booking.confirm", details: "{}" }));
  });

  it("the app role can insert and read", async () => {
    const rows = await withTenant(db.app, T, async (c) => (await c.query("select id, seq from audit_log where id = $1", [auditId])).rows);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]?.seq !== null);
  });

  it("the app role cannot update", async () => {
    const r = await attempt(db.app, T, "update audit_log set action = 'tampered' where id = $1", [auditId]);
    assert.ok(!r.ok && r.code === "42501", JSON.stringify(r));
  });

  it("the app role cannot delete or truncate", async () => {
    const d = await attempt(db.app, T, "delete from audit_log where id = $1", [auditId]);
    assert.ok(!d.ok && d.code === "42501", JSON.stringify(d));
    const all = await attempt(db.app, T, "delete from audit_log");
    assert.ok(!all.ok && all.code === "42501", JSON.stringify(all));
    const tr = await attempt(db.app, null, "truncate table audit_log");
    assert.ok(!tr.ok && tr.code === "42501", JSON.stringify(tr));
  });

  it("even the owner role is stopped by the trigger", async () => {
    const u = await attempt(db.owner, T, "update audit_log set action = 'tampered' where id = $1", [auditId]);
    assert.ok(!u.ok && u.code === "55000" && /append-only/.test(u.message), JSON.stringify(u));
    const d = await attempt(db.owner, T, "delete from audit_log where id = $1", [auditId]);
    assert.ok(!d.ok && d.code === "55000", JSON.stringify(d));
  });

  it("the row is unchanged after all attempts, and ordering numbers increase", async () => {
    const second = await withTenant(db.app, T, (c) => insertRow(c, "audit_log", { tenant_id: T, actor_kind: "system", action: "second", details: "{}" }));
    const rows = await withTenant(db.app, T, async (c) => (await c.query<{ id: string; action: string; seq: string }>("select id, action, seq from audit_log order by seq")).rows);
    assert.equal(rows.find((r) => r.id === auditId)?.action, "booking.confirm");
    assert.ok(Number(rows.find((r) => r.id === second)?.seq) > Number(rows.find((r) => r.id === auditId)?.seq));
  });

  it("rejects unknown actor kinds and outcomes", async () => {
    const a = await attempt(db.app, T, "insert into audit_log (tenant_id, actor_kind, action) values ($1, 'robot', 'x')", [T]);
    assert.ok(!a.ok && a.code === "23514");
    const o = await attempt(db.app, T, "insert into audit_log (tenant_id, actor_kind, action, outcome) values ($1, 'user', 'x', 'maybe')", [T]);
    assert.ok(!o.ok && o.code === "23514");
  });
});

describe("(e) idempotency keys", () => {
  const insertKey = (tenant: string, key: string, route: string) =>
    attempt(db.app, tenant, "insert into idempotency_keys (tenant_id, key, route, request_hash) values ($1, $2, $3, 'h')", [tenant, key, route]);

  it("the same (tenant, key, route) cannot be stored twice", async () => {
    const key = `key-${randomUUID()}`;
    assert.ok((await insertKey(T, key, "POST /v1/bookings")).ok);
    const dup = await insertKey(T, key, "POST /v1/bookings");
    assert.ok(!dup.ok && dup.code === "23505" && /idempotency_keys_unique_key/.test(dup.message), JSON.stringify(dup));
  });

  it("the same key is fine on another route or in another tenant", async () => {
    const key = `key-${randomUUID()}`;
    assert.ok((await insertKey(T, key, "POST /v1/bookings")).ok);
    assert.ok((await insertKey(T, key, "POST /v1/orders")).ok);
    assert.ok((await insertKey(T2, key, "POST /v1/bookings")).ok);
  });

  it("a concurrent race on one key has exactly one winner", async () => {
    const key = `key-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => insertKey(T, key, "tool:create_booking_hold")));
    assert.equal(results.filter((r) => r.ok).length, 1);
    for (const r of results) if (!r.ok) assert.equal(r.code, "23505");
  });

  it("entries expire after 24 hours by default and expired ones are purged", async () => {
    const key = `key-${randomUUID()}`;
    await insertKey(T, key, "POST /v1/ttl");
    const row = await withTenant(db.app, T, async (c) =>
      (await c.query<{ hours: number }>("select extract(epoch from (expires_at - created_at)) / 3600 as hours from idempotency_keys where key = $1", [key])).rows[0]);
    assert.equal(Math.round(Number(row?.hours)), 24);
    await withTenant(db.app, T, (c) => c.query("update idempotency_keys set expires_at = now() - interval '1 minute' where key = $1", [key]));
    const purged = await db.app.query<{ n: number }>("select purge_expired_idempotency_keys() as n");
    assert.ok(Number(purged.rows[0]?.n) >= 1);
    const left = await withTenant(db.app, T, async (c) => (await c.query("select 1 from idempotency_keys where key = $1", [key])).rowCount);
    assert.equal(left, 0);
  });

  it("rejects a status outside in_progress/completed and a too-short key", async () => {
    const s = await attempt(db.app, T, "insert into idempotency_keys (tenant_id, key, route, request_hash, status) values ($1, $2, 'r', 'h', 'done')", [T, `key-${randomUUID()}`]);
    assert.ok(!s.ok && s.code === "23514");
    const k = await insertKey(T, "short", "r");
    assert.ok(!k.ok && k.code === "23514");
  });
});

describe("(f) CHECK constraints reject unknown values", () => {
  let f: Awaited<ReturnType<typeof baseFixture>>;
  before(async () => {
    f = await baseFixture(db, T, { resources: 1 });
  });

  const bookingCols = () => ({ tenant_id: T, location_id: f.location, customer_id: f.customer, source_channel: "api", starts_at: at(0), ends_at: at(30) });

  async function rejected(table: string, row: Record<string, unknown>): Promise<void> {
    const names = Object.keys(row);
    const r = await attempt(db.app, T, `insert into ${table} (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
    assert.ok(!r.ok && r.code === "23514", `${table} ${JSON.stringify(row)} should be a check violation, got ${JSON.stringify(r)}`);
  }

  it("bookings.status accepts every BookingStatus and nothing else", async () => {
    for (const status of values(BookingStatus)) {
      const r = await attempt(db.app, T, "insert into bookings (tenant_id, location_id, customer_id, source_channel, starts_at, ends_at, status, hold_expires_at) values ($1, $2, $3, 'api', $4, $5, $6, $7)",
        [T, f.location, f.customer, at(0), at(30), status, status === "HOLD" ? at(5) : null]);
      assert.ok(r.ok, `${status} should be accepted: ${JSON.stringify(r)}`);
    }
    for (const bad of ["BOGUS", "confirmed", "Confirmed", "PENDING", "CANCELED", ""]) {
      await rejected("bookings", { ...bookingCols(), status: bad, hold_expires_at: at(5) });
    }
  });

  it("orders.status accepts every OrderStatus and nothing else", async () => {
    for (const status of values(OrderStatus)) {
      const r = await attempt(db.app, T, "insert into orders (tenant_id, status, source_channel) values ($1, $2, 'api')", [T, status]);
      assert.ok(r.ok, `${status} should be accepted: ${JSON.stringify(r)}`);
    }
    for (const bad of ["BOGUS", "placed", "SHIPPED", "COMPLETED"]) await rejected("orders", { tenant_id: T, status: bad, source_channel: "api" });
  });

  it("users.role, source channels, payment status and resource types reject unknown values", async () => {
    await rejected("users", { tenant_id: T, auth_provider: "dev", external_subject: "x1", name: "n", role: "ADMIN" });
    await rejected("users", { tenant_id: T, auth_provider: "dev", external_subject: "x2", name: "n", role: "owner" });
    await rejected("bookings", { ...bookingCols(), status: "CONFIRMED", source_channel: "fax" });
    await rejected("bookings", { ...bookingCols(), status: "CONFIRMED", deposit_status: "waived" });
    await rejected("orders", { tenant_id: T, source_channel: "api", payment_status: "settled" });
    await rejected("resources", { tenant_id: T, type: "spaceship", name: "r" });
    await rejected("resources", { tenant_id: T, type: "staff", name: "r", allocation_mode: "maybe" });
    await rejected("conversations", { tenant_id: T, channel: "telegram" });
  });

  it("generic tools cannot be registered: tool names are a closed list", async () => {
    const r = await attempt(db.owner, null, "insert into tool_definitions (name, permission_level, requires_idempotency_key, description) values ('execute_sql', 'WRITE', true, 'x')");
    assert.ok(!r.ok && r.code === "23514", JSON.stringify(r));
    const scope = await attempt(db.app, T, "insert into api_credentials (tenant_id, credential_type, name, lookup_id, tool_scopes) values ($1, 'widget_key', 'w', $2, ARRAY['update_any_record'])", [T, `wk_${randomUUID()}`]);
    assert.ok(!scope.ok && scope.code === "23514", JSON.stringify(scope));
  });

  it("money is integer paise and must be consistent and non-negative", async () => {
    await rejected("orders", { tenant_id: T, source_channel: "api", subtotal_paise: 1000, tax_paise: 100, total_paise: 999 });
    await rejected("orders", { tenant_id: T, source_channel: "api", subtotal_paise: -1, total_paise: -1 });
    await rejected("catalogue_items", { tenant_id: T, kind: "service", name: "n", base_price_paise: -5 });
    await rejected("payments", { tenant_id: T, booking_id: null, order_id: null, kind: "payment", method: "cash", amount_paise: 100 });
    const orderId = await withTenant(db.app, T, (c) => insertRow(c, "orders", { tenant_id: T, source_channel: "api" }));
    await rejected("payments", { tenant_id: T, order_id: orderId, kind: "payment", method: "cash", amount_paise: 0 });
    await rejected("payments", { tenant_id: T, order_id: orderId, kind: "gift", method: "cash", amount_paise: 5 });
    await rejected("payments", { tenant_id: T, order_id: orderId, kind: "payment", method: "bitcoin", amount_paise: 5 });
    await rejected("order_items", { tenant_id: T, order_id: orderId, name: "n", quantity: 2, unit_price_paise: 100, line_total_paise: 300 });
  });

  it("the payment ledger cannot be rewritten or deleted by the app role (only status settles)", async () => {
    const orderId = await withTenant(db.app, T, (c) => insertRow(c, "orders", { tenant_id: T, source_channel: "api", subtotal_paise: 500, total_paise: 500 }));
    const pid = await withTenant(db.app, T, (c) => insertRow(c, "payments", { tenant_id: T, order_id: orderId, kind: "payment", method: "cash", amount_paise: 500, status: "pending" }));
    const amount = await attempt(db.app, T, "update payments set amount_paise = 1 where id = $1", [pid]);
    assert.ok(!amount.ok && amount.code === "42501", JSON.stringify(amount));
    const del = await attempt(db.app, T, "delete from payments where id = $1", [pid]);
    assert.ok(!del.ok && del.code === "42501", JSON.stringify(del));
    const settle = await attempt(db.app, T, "update payments set status = 'completed' where id = $1", [pid]);
    assert.ok(settle.ok && settle.rowCount === 1, JSON.stringify(settle));
  });

  it("a booking must end after it starts; capacity and quantities must be positive", async () => {
    await rejected("bookings", { ...bookingCols(), status: "CONFIRMED", ends_at: at(-5) });
    await rejected("bookings", { ...bookingCols(), status: "CONFIRMED", party_size: 0 });
    await rejected("resources", { tenant_id: T, type: "table", name: "t", capacity_units: 0 });
    await rejected("customers", { tenant_id: T, name: "n", phone: "98765 43210" });
    await rejected("business_hours", { tenant_id: T, location_id: f.location, weekday: 7, open_time: "09:00", close_time: "17:00" });
    await rejected("business_hours", { tenant_id: T, location_id: f.location, weekday: 1, open_time: "17:00", close_time: "09:00" });
  });
});

describe("webhook event vocabulary", () => {
  // Written out on purpose: adding or removing an event must be a deliberate change in four places
  // (enums.ts, a migration for outbox_events and webhook_endpoints, this list, the webhook docs).
  const EVENTS_15 = [
    "booking.cancelled", "booking.completed", "booking.confirmed", "booking.created", "booking.expired", "booking.no_show",
    "booking.rescheduled", "customer.created", "order.accepted", "order.cancelled", "order.created", "order.fulfilled",
    "order.rejected", "payment.completed", "payment.refunded",
  ];

  it("@qenbel/shared WebhookEvent has exactly the 15 events", () => {
    assert.deepEqual(values(WebhookEvent), EVENTS_15);
  });

  it("outbox_events accepts each of the 15 and rejects an unknown one", async () => {
    for (const type of EVENTS_15) {
      const r = await attempt(db.app, T, "insert into outbox_events (tenant_id, type, payload) values ($1, $2, '{}'::jsonb)", [T, type]);
      assert.equal(r.ok, true, `${type}: ${r.ok ? "" : r.message}`);
    }
    const bad = await attempt(db.app, T, "insert into outbox_events (tenant_id, type, payload) values ($1, 'booking.deleted', '{}'::jsonb)", [T]);
    assert.deepEqual(bad.ok ? null : bad.code, "23514");
  });

  it("webhook_endpoints.events accepts the 15 and rejects an unknown one", async () => {
    const ok = await attempt(db.app, T, "insert into webhook_endpoints (tenant_id, url, secret_ciphertext, events) values ($1, 'https://hooks.example.com/all', 'c', $2::text[])", [T, EVENTS_15]);
    assert.equal(ok.ok, true, ok.ok ? "" : ok.message);
    const bad = await attempt(db.app, T, "insert into webhook_endpoints (tenant_id, url, secret_ciphertext, events) values ($1, 'https://hooks.example.com/bad', 'c', $2::text[])", [T, ["booking.created", "booking.deleted"]]);
    assert.deepEqual(bad.ok ? null : bad.code, "23514");
  });
});

describe("enum drift: CHECK constraints match @qenbel/shared enums.ts exactly", () => {
  const cases: [string, string, string[]][] = [
    ["bookings", "status", values(BookingStatus)],
    ["bookings", "source_channel", values(Channel)],
    ["bookings", "deposit_status", values(PaymentStatus)],
    ["orders", "status", values(OrderStatus)],
    ["orders", "source_channel", values(Channel)],
    ["orders", "payment_status", values(PaymentStatus)],
    ["users", "role", values(UserRole)],
    ["resources", "type", values(ResourceType)],
    ["catalogue_items", "required_resource_type", values(ResourceType)],
    ["customers", "source", values(Channel)],
    ["conversations", "channel", values(Channel)],
    ["audit_log", "channel", values(Channel)],
    ["audit_log", "actor_kind", values(PrincipalKind)],
    ["communications", "channel", [...values(Channel), "email", "sms"].sort()],
    ["tool_definitions", "name", values(ToolName)],
    ["tool_definitions", "permission_level", values(ToolPermissionLevel)],
    ["conversation_messages", "tool_name", values(ToolName)],
    ["api_credentials", "tool_scopes", values(ToolName)],
    ["outbox_events", "type", values(WebhookEvent)],
    ["webhook_endpoints", "events", values(WebhookEvent)],
  ];

  for (const [table, column, expected] of cases) {
    it(`${table}.${column}`, async () => {
      const res = await db.owner.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = $1::regclass and contype = 'c'`, [table]);
      const defs = res.rows.map((r) => r.def).filter((d) => new RegExp(`\\b${column}\\b\\)? (= ANY|<@)`).test(d));
      assert.equal(defs.length, 1, `expected one enum CHECK on ${table}.${column}, found ${defs.length}`);
      const actual = [...(defs[0] as string).matchAll(/'([^']+)'::text/g)].map((m) => m[1] as string).sort();
      assert.deepEqual(actual, [...expected].sort());
    });
  }
});
