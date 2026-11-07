import { randomUUID } from "node:crypto";
import type { PoolClient } from "../src/index.ts";
import { at, insertRow, type Row } from "./helpers.ts";

// One representative row for EVERY tenant table, in dependency order. The RLS test requires this list to
// cover every table that has a tenant_id column in the catalog, so adding a table without a fixture (and
// therefore without an isolation check) fails the suite.

export type Ids = Record<string, string>;
export interface FixtureEntry {
  table: string;
  row: (tenantId: string, ids: Ids) => Row;
}

const j = (v: unknown) => JSON.stringify(v);
const uniq = () => randomUUID().slice(0, 12);

export const FIXTURE: FixtureEntry[] = [
  { table: "locations", row: (t) => ({ tenant_id: t, name: "Loc" }) },
  { table: "users", row: (t) => ({ tenant_id: t, auth_provider: "dev", external_subject: `dev|${uniq()}`, name: "User", role: "OWNER" }) },
  { table: "user_locations", row: (t, i) => ({ tenant_id: t, user_id: i.users, location_id: i.locations }) },
  { table: "api_credentials", row: (t, i) => ({ tenant_id: t, credential_type: "widget_key", name: "Widget", lookup_id: `wk_${uniq()}`, tool_scopes: ["get_catalogue"], created_by_user_id: i.users }) },
  { table: "tenant_tool_settings", row: (t) => ({ tenant_id: t, tool_name: "get_catalogue", enabled: true }) },
  { table: "customers", row: (t) => ({ tenant_id: t, name: "Customer", phone: "+919000000500" }) },
  { table: "customer_tags", row: (t, i) => ({ tenant_id: t, customer_id: i.customers, tag: "vip" }) },
  { table: "customer_notes", row: (t, i) => ({ tenant_id: t, customer_id: i.customers, author_user_id: i.users, body: "note" }) },
  { table: "catalogue_categories", row: (t) => ({ tenant_id: t, name: "Cat" }) },
  { table: "catalogue_items", row: (t, i) => ({ tenant_id: t, category_id: i.catalogue_categories, kind: "service", name: "Item", base_price_paise: 1000 }) },
  { table: "catalogue_variants", row: (t, i) => ({ tenant_id: t, item_id: i.catalogue_items, name: "Var", price_paise: 1000 }) },
  { table: "resources", row: (t, i) => ({ tenant_id: t, location_id: i.locations, type: "staff", name: "Res" }) },
  { table: "resource_schedules", row: (t, i) => ({ tenant_id: t, resource_id: i.resources, weekday: 1, start_time: "09:00", end_time: "17:00" }) },
  { table: "resource_time_off", row: (t, i) => ({ tenant_id: t, resource_id: i.resources, starts_at: at(0), ends_at: at(60), reason: "Leave", created_by_user_id: i.users }) },
  { table: "resource_breaks", row: (t, i) => ({ tenant_id: t, resource_id: i.resources, weekday: 1, start_time: "13:00", end_time: "14:00" }) },
  { table: "resource_services", row: (t, i) => ({ tenant_id: t, resource_id: i.resources, catalogue_item_id: i.catalogue_items }) },
  { table: "business_hours", row: (t, i) => ({ tenant_id: t, location_id: i.locations, weekday: 1, open_time: "09:00", close_time: "17:00" }) },
  { table: "holidays", row: (t, i) => ({ tenant_id: t, location_id: i.locations, holiday_date: "2031-01-26", name: "Holiday" }) },
  { table: "conversations", row: (t, i) => ({ tenant_id: t, channel: "web_chat", customer_id: i.customers, api_credential_id: i.api_credentials }) },
  { table: "conversation_messages", row: (t, i) => ({ tenant_id: t, conversation_id: i.conversations, seq: 0, role: "user", content: "hi" }) },
  { table: "bookings", row: (t, i) => ({ tenant_id: t, location_id: i.locations, customer_id: i.customers, status: "CONFIRMED", source_channel: "api", starts_at: at(0), ends_at: at(30) }) },
  { table: "booking_allocations", row: (t, i) => ({ tenant_id: t, booking_id: i.bookings, resource_id: i.resources, period: `[${at(0).toISOString()},${at(30).toISOString()})` }) },
  { table: "orders", row: (t, i) => ({ tenant_id: t, customer_id: i.customers, booking_id: i.bookings, source_channel: "api", subtotal_paise: 1000, tax_paise: 0, total_paise: 1000 }) },
  { table: "order_items", row: (t, i) => ({ tenant_id: t, order_id: i.orders, catalogue_item_id: i.catalogue_items, name: "Item", quantity: 1, unit_price_paise: 1000, line_total_paise: 1000 }) },
  { table: "payments", row: (t, i) => ({ tenant_id: t, order_id: i.orders, customer_id: i.customers, kind: "payment", method: "cash", amount_paise: 1000 }) },
  { table: "fulfilments", row: (t, i) => ({ tenant_id: t, order_id: i.orders, type: "pickup" }) },
  { table: "follow_up_tasks", row: (t, i) => ({ tenant_id: t, customer_id: i.customers, title: "Call back" }) },
  { table: "communications", row: (t, i) => ({ tenant_id: t, customer_id: i.customers, direction: "inbound", channel: "whatsapp", body: "hello" }) },
  { table: "notification_templates", row: (t) => ({ tenant_id: t, key: "booking.confirmed", channel: "email", body: "Confirmed" }) },
  { table: "notifications", row: (t, i) => ({ tenant_id: t, template_id: i.notification_templates, customer_id: i.customers, channel: "email", recipient: "a@example.com", body: "Confirmed" }) },
  { table: "idempotency_keys", row: (t) => ({ tenant_id: t, key: `key-${uniq()}`, route: "POST /v1/bookings", request_hash: "abc" }) },
  { table: "audit_log", row: (t) => ({ tenant_id: t, actor_kind: "system", action: "test.fixture", details: j({}) }) },
  { table: "outbox_events", row: (t, i) => ({ tenant_id: t, type: "booking.created", aggregate_id: i.bookings, payload: j({ n: 1 }) }) },
  { table: "webhook_endpoints", row: (t) => ({ tenant_id: t, url: "https://hooks.example.com/x", secret_ciphertext: "ciphertext", events: ["booking.created"] }) },
  { table: "webhook_deliveries", row: (t, i) => ({ tenant_id: t, endpoint_id: i.webhook_endpoints, event_id: randomUUID(), event_type: "booking.created", attempt: 1 }) },
];

/** Insert the whole fixture for one tenant inside an open tenant transaction. Returns ids by table. */
export async function insertFixture(client: PoolClient, tenantId: string): Promise<Ids> {
  const ids: Ids = {};
  for (const entry of FIXTURE) {
    ids[entry.table] = await insertRow(client, entry.table, entry.row(tenantId, ids));
  }
  return ids;
}
