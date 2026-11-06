import { randomUUID } from "node:crypto";
import { assertLocalDevDatabase } from "./config.ts";
import type { Pool, PoolClient } from "./pool.ts";
import { withTenant } from "./tenant.ts";

// Fake data only. Two demo tenants (a salon and a restaurant) with users, locations, resources, a catalogue,
// customers, bookings and orders. Phone numbers and emails are invented and use reserved example domains.
// Everything tenant-owned is written through withTenant() as the runtime role, so the seed exercises RLS.

export const SALON_TENANT_ID = "a0000000-0000-4000-8000-000000000001";
export const RESTAURANT_TENANT_ID = "a0000000-0000-4000-8000-000000000002";

export interface SeedOptions {
  /** Pool as qenbel_app. Required. */
  appPool: Pool;
  /** Pool as qenbel_migrate. Needed for `reset` and for the dev platform admin. */
  migratePool?: Pool;
  /** Truncate all tenant data first (local development databases only). */
  reset?: boolean;
  /** URL of the migrate pool, used only to refuse `reset` on non-local hosts. */
  migrateUrl?: string;
  log?: (line: string) => void;
}

export interface SeedSummary {
  tenants: { slug: string; id: string; created: boolean }[];
}

type Row = Record<string, unknown>;
const IDENT = /^[a-z_][a-z0-9_]*$/;

/** jsonb value: pass as a JSON string so arrays are not mistaken for Postgres arrays. */
const json = (v: unknown): string => JSON.stringify(v);

async function insert(client: PoolClient, table: string, row: Row): Promise<string> {
  const cols = Object.keys(row);
  if (!IDENT.test(table) || !cols.every((c) => IDENT.test(c))) throw new Error("seed: bad identifier");
  const id = (row.id as string | undefined) ?? randomUUID();
  const all: Row = { id, ...row };
  const names = Object.keys(all);
  const sql = `insert into ${table} (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`;
  await client.query(sql, Object.values(all));
  return id;
}

/** UTC instant for hh:mm India Standard Time on the IST calendar day `dayOffset` days from today. */
function istAt(dayOffset: number, hh: number, mm = 0): Date {
  const IST = 5.5 * 3_600_000;
  const ist = new Date(Date.now() + IST);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + dayOffset, hh, mm) - IST);
}
const plusMinutes = (d: Date, m: number): Date => new Date(d.getTime() + m * 60_000);
const range = (a: Date, b: Date): string => `[${a.toISOString()},${b.toISOString()})`;

const ALL_TOOLS = [
  "get_business_profile", "search_customer", "get_catalogue", "check_availability",
  "create_booking_hold", "confirm_booking", "reschedule_booking", "cancel_booking",
  "get_order_status", "create_order_draft", "confirm_order", "cancel_order", "escalate_to_human",
] as const;
const CHAT_SAFE = ["get_business_profile", "get_catalogue", "check_availability", "create_booking_hold", "confirm_booking", "escalate_to_human"];

async function allocate(client: PoolClient, tenantId: string, bookingId: string, resourceId: string, start: Date, end: Date,
  opts: { units?: number; expiresAt?: Date | null } = {}): Promise<void> {
  await client.query(
    `insert into booking_allocations (tenant_id, booking_id, resource_id, period, units, expires_at)
     values ($1, $2, $3, $4::tstzrange, $5, $6)`,
    [tenantId, bookingId, resourceId, range(start, end), opts.units ?? 1, opts.expiresAt ?? null],
  );
}

async function seedSalon(c: PoolClient, t: string): Promise<void> {
  const loc = await insert(c, "locations", {
    tenant_id: t, name: "Demo Salon, Indiranagar", is_default: true, phone: "+919000000001", timezone: "Asia/Kolkata",
    address: json({ line1: "100 Example Road", city: "Bengaluru", state: "Karnataka", postalCode: "560000", country: "IN" }),
  });
  const owner = await insert(c, "users", { tenant_id: t, auth_provider: "dev", external_subject: "dev|salon-owner", email: "owner@demo-salon.example", name: "Salon Owner (fake)", role: "OWNER" });
  const manager = await insert(c, "users", { tenant_id: t, auth_provider: "dev", external_subject: "dev|salon-manager", email: "manager@demo-salon.example", name: "Salon Manager (fake)", role: "MANAGER" });
  const staff1 = await insert(c, "users", { tenant_id: t, auth_provider: "dev", external_subject: "dev|salon-staff-1", email: "asha@demo-salon.example", name: "Asha (fake)", role: "STAFF" });
  for (const u of [owner, manager, staff1]) await insert(c, "user_locations", { tenant_id: t, user_id: u, location_id: loc });

  const asha = await insert(c, "resources", { tenant_id: t, location_id: loc, user_id: staff1, type: "staff", name: "Asha" });
  const ravi = await insert(c, "resources", { tenant_id: t, location_id: loc, type: "staff", name: "Ravi" });
  const meena = await insert(c, "resources", { tenant_id: t, location_id: loc, type: "staff", name: "Meena" });
  await insert(c, "resources", { tenant_id: t, location_id: loc, type: "room", name: "Colour room" });
  for (const r of [asha, ravi, meena]) {
    for (let d = 1; d <= 6; d++) await insert(c, "resource_schedules", { tenant_id: t, resource_id: r, weekday: d, start_time: "10:00", end_time: "19:00" });
  }
  for (let d = 1; d <= 6; d++) await insert(c, "business_hours", { tenant_id: t, location_id: loc, weekday: d, open_time: "10:00", close_time: "20:00" });
  await insert(c, "holidays", { tenant_id: t, location_id: null, holiday_date: istAt(30, 0).toISOString().slice(0, 10), name: "Demo closure day" });

  const hair = await insert(c, "catalogue_categories", { tenant_id: t, name: "Hair", sort_order: 1 });
  const skin = await insert(c, "catalogue_categories", { tenant_id: t, name: "Skin", sort_order: 2 });
  const retail = await insert(c, "catalogue_categories", { tenant_id: t, name: "Retail", sort_order: 3 });
  const haircut = await insert(c, "catalogue_items", { tenant_id: t, category_id: hair, kind: "service", name: "Haircut", base_price_paise: 50000, duration_minutes: 45, required_resource_type: "staff", tax_rate_bps: 1800 });
  const colour = await insert(c, "catalogue_items", { tenant_id: t, category_id: hair, kind: "service", name: "Hair colour", base_price_paise: 200000, duration_minutes: 120, required_resource_type: "staff", tax_rate_bps: 1800 });
  for (const [name, price, order] of [["Short", 200000, 1], ["Medium", 300000, 2], ["Long", 400000, 3]] as const) {
    await insert(c, "catalogue_variants", { tenant_id: t, item_id: colour, name, price_paise: price, sort_order: order });
  }
  await insert(c, "catalogue_items", { tenant_id: t, category_id: hair, kind: "service", name: "Head massage", base_price_paise: 30000, duration_minutes: 30, required_resource_type: "staff", tax_rate_bps: 1800 });
  await insert(c, "catalogue_items", { tenant_id: t, category_id: skin, kind: "service", name: "Facial", base_price_paise: 150000, duration_minutes: 60, required_resource_type: "staff", tax_rate_bps: 1800 });
  const shampoo = await insert(c, "catalogue_items", { tenant_id: t, category_id: retail, kind: "product", name: "Shampoo 250 ml", sku: "SH-250", base_price_paise: 45000, tax_rate_bps: 1800 });

  for (const tool of ALL_TOOLS) {
    await insert(c, "tenant_tool_settings", { tenant_id: t, tool_name: tool, enabled: ["get_business_profile", "search_customer", "get_catalogue", "check_availability", "create_booking_hold", "confirm_booking", "cancel_booking", "escalate_to_human"].includes(tool) });
  }
  await insert(c, "api_credentials", { tenant_id: t, credential_type: "widget_key", name: "Website chat (demo)", lookup_id: "wk_demo_salon_0001", tool_scopes: CHAT_SAFE, allowed_origins: ["http://localhost:5173"], created_by_user_id: owner });

  const c1 = await insert(c, "customers", { tenant_id: t, name: "Test Customer One (fake)", phone: "+919000000101", email: "one@example.com", source: "dashboard" });
  const c2 = await insert(c, "customers", { tenant_id: t, name: "Test Customer Two (fake)", phone: "+919000000102", source: "whatsapp", consent_marketing: true, consent_updated_at: new Date() });
  const c3 = await insert(c, "customers", { tenant_id: t, name: "Test Customer Three (fake)", phone: "+919000000103", email: "three@example.com", source: "web_chat" });
  await insert(c, "customer_tags", { tenant_id: t, customer_id: c1, tag: "regular" });
  await insert(c, "customer_notes", { tenant_id: t, customer_id: c1, author_user_id: manager, body: "Prefers appointments after 4 pm." });
  await insert(c, "communications", { tenant_id: t, customer_id: c2, direction: "inbound", channel: "whatsapp", body: "Hi, do you have a slot tomorrow?" });

  const day = (n: number) => istAt(n, 11);
  const confirmed = await insert(c, "bookings", { tenant_id: t, location_id: loc, customer_id: c1, catalogue_item_id: haircut, status: "CONFIRMED", source_channel: "dashboard", starts_at: day(1), ends_at: plusMinutes(day(1), 45), confirmed_at: new Date(), policy_snapshot: json({ cancelBeforeHours: 4 }) });
  await allocate(c, t, confirmed, asha, day(1), plusMinutes(day(1), 45));
  const holdEnds = plusMinutes(new Date(), 10);
  const hold = await insert(c, "bookings", { tenant_id: t, location_id: loc, customer_id: c2, catalogue_item_id: haircut, status: "HOLD", source_channel: "whatsapp", starts_at: istAt(1, 15), ends_at: plusMinutes(istAt(1, 15), 45), hold_expires_at: holdEnds });
  await allocate(c, t, hold, ravi, istAt(1, 15), plusMinutes(istAt(1, 15), 45), { expiresAt: holdEnds });
  const done = await insert(c, "bookings", { tenant_id: t, location_id: loc, customer_id: c3, catalogue_item_id: haircut, status: "COMPLETED", source_channel: "api", starts_at: istAt(-1, 12), ends_at: plusMinutes(istAt(-1, 12), 45), confirmed_at: istAt(-2, 12) });
  await allocate(c, t, done, meena, istAt(-1, 12), plusMinutes(istAt(-1, 12), 45));

  const order = await insert(c, "orders", { tenant_id: t, location_id: loc, customer_id: c3, booking_id: done, status: "FULFILLED", source_channel: "dashboard", payment_status: "paid", subtotal_paise: 45000, tax_paise: 8100, total_paise: 53100, placed_at: istAt(-1, 13), fulfilled_at: istAt(-1, 13) });
  await insert(c, "order_items", { tenant_id: t, order_id: order, catalogue_item_id: shampoo, name: "Shampoo 250 ml", quantity: 1, unit_price_paise: 45000, tax_paise: 8100, line_total_paise: 45000 });
  await insert(c, "payments", { tenant_id: t, order_id: order, customer_id: c3, kind: "payment", method: "cash", status: "completed", amount_paise: 53100 });
  await insert(c, "fulfilments", { tenant_id: t, order_id: order, type: "on_site", status: "completed", completed_at: istAt(-1, 13) });

  await insert(c, "notification_templates", { tenant_id: t, key: "booking.confirmed", channel: "whatsapp", subject: null, body: "Your booking {{reference}} on {{date}} is confirmed." });
  await insert(c, "notification_templates", { tenant_id: t, key: "booking.confirmed", channel: "email", subject: "Booking confirmed", body: "Your booking {{reference}} on {{date}} is confirmed." });

  const convo = await insert(c, "conversations", { tenant_id: t, channel: "whatsapp", customer_id: c2, external_ref: "demo-thread-salon-1", last_message_at: new Date() });
  await insert(c, "conversation_messages", { tenant_id: t, conversation_id: convo, seq: 0, role: "user", content: "Hi, do you have a haircut slot tomorrow afternoon?" });
  await insert(c, "conversation_messages", { tenant_id: t, conversation_id: convo, seq: 1, role: "assistant", content: "Let me check availability.", input_tokens: 120, output_tokens: 12 });
  await insert(c, "follow_up_tasks", { tenant_id: t, customer_id: c2, conversation_id: convo, title: "Call back about colour pricing", origin: "ai_escalation", due_at: istAt(1, 10) });

  await insert(c, "outbox_events", { tenant_id: t, type: "booking.created", aggregate_type: "booking", aggregate_id: hold, payload: json({ bookingId: hold }) });
  await insert(c, "audit_log", { tenant_id: t, actor_kind: "system", actor_id: "seed", action: "seed.completed", entity_type: "tenant", entity_id: t, details: json({ note: "demo data" }) });
}

async function seedRestaurant(c: PoolClient, t: string): Promise<void> {
  const loc = await insert(c, "locations", {
    tenant_id: t, name: "Demo Restaurant, Koramangala", is_default: true, phone: "+919000000002", timezone: "Asia/Kolkata",
    address: json({ line1: "200 Example Street", city: "Bengaluru", state: "Karnataka", postalCode: "560001", country: "IN" }),
  });
  const owner = await insert(c, "users", { tenant_id: t, auth_provider: "dev", external_subject: "dev|restaurant-owner", email: "owner@demo-restaurant.example", name: "Restaurant Owner (fake)", role: "OWNER" });
  const manager = await insert(c, "users", { tenant_id: t, auth_provider: "dev", external_subject: "dev|restaurant-manager", email: "manager@demo-restaurant.example", name: "Restaurant Manager (fake)", role: "MANAGER" });
  const host = await insert(c, "users", { tenant_id: t, auth_provider: "dev", external_subject: "dev|restaurant-host", email: "host@demo-restaurant.example", name: "Host (fake)", role: "STAFF" });
  for (const u of [owner, manager, host]) await insert(c, "user_locations", { tenant_id: t, user_id: u, location_id: loc });

  const tables: string[] = [];
  for (const [name, seats] of [["T1", 2], ["T2", 2], ["T3", 4], ["T4", 4], ["T5", 6], ["T6", 8]] as const) {
    tables.push(await insert(c, "resources", { tenant_id: t, location_id: loc, type: "table", name, capacity_units: seats }));
  }
  const counter = await insert(c, "resources", { tenant_id: t, location_id: loc, type: "table", name: "Counter seating", allocation_mode: "shared", capacity_units: 12 });
  for (let d = 0; d <= 6; d++) {
    await insert(c, "business_hours", { tenant_id: t, location_id: loc, weekday: d, open_time: "12:00", close_time: "15:00" });
    await insert(c, "business_hours", { tenant_id: t, location_id: loc, weekday: d, open_time: "19:00", close_time: "23:00" });
  }

  const starters = await insert(c, "catalogue_categories", { tenant_id: t, name: "Starters", sort_order: 1 });
  const mains = await insert(c, "catalogue_categories", { tenant_id: t, name: "Mains", sort_order: 2 });
  const drinks = await insert(c, "catalogue_categories", { tenant_id: t, name: "Drinks", sort_order: 3 });
  await insert(c, "catalogue_items", { tenant_id: t, category_id: starters, kind: "product", name: "Paneer tikka", base_price_paise: 24000, tax_rate_bps: 500, attributes: json({ vegetarian: true }) });
  const biryani = await insert(c, "catalogue_items", { tenant_id: t, category_id: mains, kind: "product", name: "Veg biryani", base_price_paise: 26000, tax_rate_bps: 500, attributes: json({ vegetarian: true }) });
  await insert(c, "catalogue_variants", { tenant_id: t, item_id: biryani, name: "Half", price_paise: 26000, sort_order: 1 });
  await insert(c, "catalogue_variants", { tenant_id: t, item_id: biryani, name: "Full", price_paise: 42000, sort_order: 2 });
  const dal = await insert(c, "catalogue_items", { tenant_id: t, category_id: mains, kind: "product", name: "Dal tadka", base_price_paise: 18000, tax_rate_bps: 500, attributes: json({ vegetarian: true }) });
  await insert(c, "catalogue_items", { tenant_id: t, category_id: drinks, kind: "product", name: "Masala chaas", base_price_paise: 6000, tax_rate_bps: 500 });

  for (const tool of ALL_TOOLS) {
    await insert(c, "tenant_tool_settings", { tenant_id: t, tool_name: tool, enabled: ["get_business_profile", "get_catalogue", "check_availability", "create_booking_hold", "confirm_booking", "get_order_status", "escalate_to_human"].includes(tool) });
  }
  await insert(c, "api_credentials", { tenant_id: t, credential_type: "widget_key", name: "Website chat (demo)", lookup_id: "wk_demo_restaurant_0001", tool_scopes: CHAT_SAFE, allowed_origins: ["http://localhost:5173"], created_by_user_id: owner });

  const c1 = await insert(c, "customers", { tenant_id: t, name: "Test Diner One (fake)", phone: "+919000000201", email: "diner1@example.com", source: "dashboard" });
  const c2 = await insert(c, "customers", { tenant_id: t, name: "Test Diner Two (fake)", phone: "+919000000202", source: "whatsapp", attributes: json({ allergies: "none" }) });
  const c3 = await insert(c, "customers", { tenant_id: t, name: "Test Diner Three (fake)", phone: "+919000000203", source: "voice" });
  await insert(c, "customer_tags", { tenant_id: t, customer_id: c1, tag: "birthday-booking" });

  const dinner = istAt(1, 20);
  const confirmed = await insert(c, "bookings", { tenant_id: t, location_id: loc, customer_id: c1, status: "CONFIRMED", source_channel: "web_chat", starts_at: dinner, ends_at: plusMinutes(dinner, 90), party_size: 4, confirmed_at: new Date(), policy_snapshot: json({ holdMinutes: 15 }) });
  await allocate(c, t, confirmed, tables[2] as string, dinner, plusMinutes(dinner, 90));
  const holdEnds = plusMinutes(new Date(), 15);
  const hold = await insert(c, "bookings", { tenant_id: t, location_id: loc, customer_id: c2, status: "HOLD", source_channel: "whatsapp", starts_at: dinner, ends_at: plusMinutes(dinner, 90), party_size: 2, hold_expires_at: holdEnds });
  await allocate(c, t, hold, tables[0] as string, dinner, plusMinutes(dinner, 90), { expiresAt: holdEnds });
  const counterBooking = await insert(c, "bookings", { tenant_id: t, location_id: loc, customer_id: c3, status: "CONFIRMED", source_channel: "voice", starts_at: dinner, ends_at: plusMinutes(dinner, 60), party_size: 3, confirmed_at: new Date() });
  await allocate(c, t, counterBooking, counter, dinner, plusMinutes(dinner, 60), { units: 3 });

  const order = await insert(c, "orders", { tenant_id: t, location_id: loc, customer_id: c1, booking_id: confirmed, status: "PROCESSING", source_channel: "dashboard", payment_status: "unpaid", subtotal_paise: 60000, tax_paise: 3000, total_paise: 63000, placed_at: new Date() });
  await insert(c, "order_items", { tenant_id: t, order_id: order, catalogue_item_id: biryani, name: "Veg biryani (Full)", quantity: 1, unit_price_paise: 42000, tax_paise: 2100, line_total_paise: 42000 });
  await insert(c, "order_items", { tenant_id: t, order_id: order, catalogue_item_id: dal, name: "Dal tadka", quantity: 1, unit_price_paise: 18000, tax_paise: 900, line_total_paise: 18000 });
  await insert(c, "fulfilments", { tenant_id: t, order_id: order, type: "dine_in", status: "in_progress" });
  await insert(c, "orders", { tenant_id: t, location_id: loc, customer_id: c2, status: "DRAFT", source_channel: "whatsapp" });

  await insert(c, "notification_templates", { tenant_id: t, key: "booking.confirmed", channel: "whatsapp", body: "Your table booking {{reference}} for {{partySize}} is confirmed." });
  await insert(c, "outbox_events", { tenant_id: t, type: "booking.created", aggregate_type: "booking", aggregate_id: hold, payload: json({ bookingId: hold }) });
  await insert(c, "audit_log", { tenant_id: t, actor_kind: "system", actor_id: "seed", action: "seed.completed", entity_type: "tenant", entity_id: t, details: json({ note: "demo data" }) });
}

export async function seed(options: SeedOptions): Promise<SeedSummary> {
  const log = options.log ?? (() => {});
  const { appPool, migratePool } = options;

  if (options.reset) {
    if (!migratePool || !options.migrateUrl) throw new Error("seed --reset needs the migrate connection");
    assertLocalDevDatabase(options.migrateUrl);
    // TRUNCATE is not subject to RLS; it needs ownership, which only the migrate role has.
    await migratePool.query("truncate table tenants, platform_admins cascade");
    log("reset: all tenant data and platform admins removed");
  }

  const defs = [
    { id: SALON_TENANT_ID, slug: "demo-salon", name: "Demo Salon (fake data)", pack: "salon", fill: seedSalon },
    { id: RESTAURANT_TENANT_ID, slug: "demo-restaurant", name: "Demo Restaurant (fake data)", pack: "restaurant", fill: seedRestaurant },
  ] as const;

  const summary: SeedSummary = { tenants: [] };
  for (const def of defs) {
    const exists = await withTenant(appPool, def.id, async (c) => (await c.query("select 1 from tenants where id = $1", [def.id])).rowCount === 1);
    if (!exists) {
      await appPool.query("select platform_create_tenant($1, $2, 'central', $3, '1.0.0', 'Asia/Kolkata', $4)", [def.slug, def.name, def.pack, def.id]);
    }
    const alreadySeeded = await withTenant(appPool, def.id, async (c) => ((await c.query("select count(*)::int as n from locations")).rows[0] as { n: number }).n > 0);
    if (alreadySeeded) {
      log(`${def.slug}: already seeded, skipped (use --reset to start over)`);
      summary.tenants.push({ slug: def.slug, id: def.id, created: false });
      continue;
    }
    await withTenant(appPool, def.id, (c) => def.fill(c, def.id));
    log(`${def.slug}: seeded`);
    summary.tenants.push({ slug: def.slug, id: def.id, created: true });
  }

  if (migratePool) {
    await migratePool.query(
      `insert into platform_admins (auth_provider, external_subject, email, name)
       values ('dev', 'dev|platform-admin', 'admin@qenbel-admin.example', 'Platform Admin (fake)')
       on conflict (auth_provider, external_subject) do nothing`);
  }
  return summary;
}
