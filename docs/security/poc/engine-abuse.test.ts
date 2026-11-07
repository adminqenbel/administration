// Security PoC: abuse of the Stage 2 engines (bookings, orders, catalogue/CRM) by a customer-facing actor.
//
// Run:  node docs/security/poc/setup-scratch-db.mjs   (once)
//       node --test docs/security/poc/engine-abuse.test.ts
//
// Only touches the scratch database qenbel_admin_sec_test. Contexts model what the API will build for a
// customer-facing channel: actor.kind "api_credential", channel "web_chat" or "whatsapp", tenantId from the principal.
//
// [GUARD]  regression guard, passes today.
// [DEFECT SEC-nnn]  asserts the SAFE behaviour, so it FAILS today; marked `todo` so the run stays green. Remove `todo` when fixed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createPool, resolveDatabaseUrls, runMigrations, withTenant, type Pool, type PoolClient } from "@qenbel/db";
import { cancelBooking, confirmBooking, createHold, rescheduleBooking } from "@qenbel/engine-bookings";
import { searchCustomersForAi } from "@qenbel/engine-catalog";
import { applyDiscount, cancelOrder, createOrderDraft, placeOrder, recordPayment, recordRefund } from "@qenbel/engine-orders";
import { AppError, type Channel, type EngineContext } from "@qenbel/shared";

const SCRATCH = "qenbel_admin_sec_test";
for (const v of ["DATABASE_URL", "DATABASE_MIGRATE_URL", "TEST_DATABASE_URL", "TEST_DATABASE_MIGRATE_URL"]) delete process.env[v];

// Friday 2030-12-20 00:00Z. Monday 2030-12-23 10:00 IST = 04:30Z. The salon is open Mon-Sat 10:00-20:00 IST.
const NOW = new Date("2030-12-20T00:00:00.000Z");
const MON_10 = Date.parse("2030-12-23T04:30:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let app: Pool;
let owner: Pool;

function ctx(tenantId: string, o: { channel?: Channel; actorId?: string; key?: string } = {}): EngineContext {
  return {
    tenantId,
    actor: { kind: "api_credential", id: o.actorId ?? "cred-1", channel: o.channel ?? "web_chat" },
    now: () => new Date(NOW),
    newId: () => randomUUID(),
    ...(o.key !== undefined ? { idempotencyKey: o.key } : {}),
  };
}
const tx = <T>(tenantId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(app, tenantId, fn);

async function insert(c: PoolClient, table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row.id as string | undefined) ?? randomUUID();
  const all = { id, ...row };
  const names = Object.keys(all);
  await c.query(`insert into ${table} (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(all));
  return id;
}

async function mkTenant(pack: string, label: string): Promise<string> {
  const r = await app.query<{ id: string }>("select platform_create_tenant($1, $2, 'central', $3, '1.0.0') as id", [
    `sec-${label}-${randomUUID().slice(0, 8)}`,
    `Sec ${label}`,
    pack,
  ]);
  return (r.rows[0] as { id: string }).id;
}

interface Salon {
  tenantId: string;
  staffA: string;
  staffB: string;
  serviceId: string;
  alice: string;
  bob: string;
}
async function seedSalon(): Promise<Salon> {
  const tenantId = await mkTenant("salon", "salon");
  return tx(tenantId, async (c) => {
    const t = { tenant_id: tenantId };
    const loc = await insert(c, "locations", { ...t, name: "Main", timezone: "Asia/Kolkata", is_default: true });
    for (const weekday of [1, 2, 3, 4, 5, 6]) await insert(c, "business_hours", { ...t, location_id: loc, weekday, open_time: "10:00", close_time: "20:00" });
    const staffA = await insert(c, "resources", { ...t, location_id: loc, type: "staff", name: "Staff A" });
    const staffB = await insert(c, "resources", { ...t, location_id: loc, type: "staff", name: "Staff B" });
    const serviceId = await insert(c, "catalogue_items", { ...t, kind: "service", name: "Haircut", base_price_paise: 50000, duration_minutes: 60, required_resource_type: "staff" });
    const alice = await insert(c, "customers", { ...t, name: "Alice Anand", phone: "+919811100001", email: "alice@example.com" });
    const bob = await insert(c, "customers", { ...t, name: "Bob Bhat", phone: "+919811100002", email: "bob@example.com" });
    return { tenantId, staffA, staffB, serviceId, alice, bob };
  });
}

before(async () => {
  const urls = resolveDatabaseUrls(SCRATCH);
  owner = createPool({ connectionString: urls.migrateUrl, max: 2, applicationName: "sec-poc-owner" });
  app = createPool({ connectionString: urls.appUrl, max: 8, applicationName: "sec-poc-app" });
  assert.equal((await owner.query<{ d: string }>("select current_database() as d")).rows[0]?.d, SCRATCH, "refusing to run: not the scratch database");
  await runMigrations(owner);
});
after(async () => {
  await Promise.allSettled([app?.end(), owner?.end()]);
});

async function confirmedBookingFor(s: Salon, customerId: string, startMs: number, resourceId: string): Promise<{ id: string; version: number }> {
  const dash = ctx(s.tenantId, { channel: "dashboard" });
  const hold = await tx(s.tenantId, (c) => createHold(c, dash, { startsAt: iso(startMs), catalogueItemId: s.serviceId, resourceId }));
  const conf = await tx(s.tenantId, (c) => confirmBooking(c, dash, { bookingId: hold.booking.id, customerId }));
  return { id: conf.booking.id, version: conf.booking.version };
}

describe("bookings: slot denial and ownership", () => {
  test(
    "[DEFECT SEC-004] an anonymous web-chat actor cannot pile up unconfirmed holds without limit",
    { todo: "SEC-004: no cap on open holds per actor / customer / conversation / tenant" },
    async () => {
      const s = await seedSalon();
      const cc = ctx(s.tenantId, { channel: "web_chat" });
      let accepted = 0;
      // 30 different one-hour slots on staff A across Monday..Wednesday, each its own request (own idempotency key).
      for (let i = 0; i < 30; i++) {
        const day = Math.floor(i / 10);
        const startsAt = iso(MON_10 + day * 86_400_000 + (i % 10) * 3_600_000);
        try {
          await tx(s.tenantId, (c) => createHold(c, { ...cc, idempotencyKey: `sec-hoard-${i}-${randomUUID().slice(0, 6)}` }, { startsAt, catalogueItemId: s.serviceId, resourceId: s.staffA }));
          accepted++;
        } catch {
          // refused: good
        }
      }
      assert.ok(accepted <= 5, `one anonymous actor holds ${accepted} slots at once (no per-actor cap)`);
    },
  );

  test(
    "[DEFECT SEC-005] a customer channel cannot hold a whole working day with one call by choosing its own duration",
    { todo: "SEC-005: customer channels may pass durationMinutes/endsAt instead of the service duration" },
    async () => {
      const s = await seedSalon();
      const cc = ctx(s.tenantId, { channel: "web_chat" });
      let heldMinutes = 0;
      try {
        const r = await tx(s.tenantId, (c) => createHold(c, cc, { startsAt: iso(MON_10), durationMinutes: 600, resourceId: s.staffA }));
        heldMinutes = (Date.parse(r.booking.endsAt) - Date.parse(r.booking.startsAt)) / 60_000;
      } catch {
        heldMinutes = 0;
      }
      assert.ok(heldMinutes <= 60, `one call held ${heldMinutes} minutes of staff A's day (the Haircut service is 60 minutes)`);
    },
  );

  test(
    "[DEFECT SEC-008] a customer channel cannot cancel or move someone else's confirmed booking just by knowing its id",
    { todo: "SEC-008: engine-bookings has no caller-ownership parameter (orders have onBehalfOfCustomerId; bookings have nothing)" },
    async () => {
      const s = await seedSalon();
      const b = await confirmedBookingFor(s, s.alice, MON_10 + 5 * 86_400_000, s.staffA);
      const whatsappOfBob = ctx(s.tenantId, { channel: "whatsapp", actorId: "cred-whatsapp" });
      let cancelled = false;
      try {
        await tx(s.tenantId, (c) => cancelBooking(c, whatsappOfBob, { bookingId: b.id, reason: "not me" }));
        cancelled = true;
      } catch {
        cancelled = false;
      }
      assert.equal(cancelled, false, "a WhatsApp-channel call cancelled Alice's booking with no proof that the caller is Alice");
    },
  );

  test("[GUARD] a booking id from another tenant is NOT_FOUND, not readable, not cancellable", async () => {
    const s1 = await seedSalon();
    const s2 = await seedSalon();
    const b = await confirmedBookingFor(s1, s1.alice, MON_10 + 2 * 86_400_000, s1.staffA);
    await assert.rejects(
      tx(s2.tenantId, (c) => cancelBooking(c, ctx(s2.tenantId, { channel: "dashboard" }), { bookingId: b.id })),
      (e: AppError) => e instanceof AppError && e.code === "NOT_FOUND",
    );
    await assert.rejects(
      tx(s2.tenantId, (c) => rescheduleBooking(c, ctx(s2.tenantId, { channel: "dashboard" }), { bookingId: b.id, startsAt: iso(MON_10), expectedVersion: 2 })),
      (e: AppError) => e instanceof AppError && e.code === "NOT_FOUND",
    );
  });

  test("[GUARD] a smuggled tenantId, status or unit price is rejected by the strict engine schemas", async () => {
    const s = await seedSalon();
    const cc = ctx(s.tenantId);
    await assert.rejects(tx(s.tenantId, (c) => createHold(c, cc, { startsAt: iso(MON_10), durationMinutes: 30, resourceId: s.staffA, tenantId: randomUUID() })), (e: AppError) => e.code === "VALIDATION_FAILED");
    await assert.rejects(tx(s.tenantId, (c) => createHold(c, cc, { startsAt: iso(MON_10), durationMinutes: 30, status: "CONFIRMED" })), (e: AppError) => e.code === "VALIDATION_FAILED");
  });

  test("[GUARD] an engine call whose SQL client is not scoped to the context tenant stops before touching data", async () => {
    const s1 = await seedSalon();
    const s2 = await seedSalon();
    await assert.rejects(
      tx(s1.tenantId, (c) => createHold(c, ctx(s2.tenantId), { startsAt: iso(MON_10), durationMinutes: 30, resourceId: s2.staffA })),
      (e: AppError) => e instanceof AppError && e.code === "TENANT_REQUIRED",
    );
  });
});

describe("idempotency", () => {
  test(
    "[DEFECT SEC-010] a second credential in the same tenant cannot receive the first credential's stored result by repeating its key and body",
    { todo: "SEC-010: idempotency rows are keyed (tenant, key, route); the principal is not part of the key or the hash" },
    async () => {
      const s = await seedSalon();
      const body = { startsAt: iso(MON_10 + 7 * 86_400_000), catalogueItemId: s.serviceId, resourceId: s.staffA };
      const key = `voice-call-4711-hold-1`;
      const first = await tx(s.tenantId, (c) => createHold(c, ctx(s.tenantId, { actorId: "cred-voice", key }), body));
      let second: Awaited<ReturnType<typeof createHold>> | undefined;
      try {
        second = await tx(s.tenantId, (c) => createHold(c, ctx(s.tenantId, { actorId: "cred-widget-attacker", channel: "web_chat", key }), body));
      } catch {
        second = undefined;
      }
      assert.ok(second === undefined || second.booking.id !== first.booking.id, "the widget credential was handed the voice credential's booking by replaying its key");
    },
  );
});

describe("customer lookup by an AI tool", () => {
  test(
    "[DEFECT SEC-006] search_customer on a customer channel cannot be used to find other customers by partial name or by phone",
    { todo: "SEC-006: the tool says results are limited to the contact in the conversation; the engine does not do it" },
    async () => {
      const s = await seedSalon();
      const byName = await tx(s.tenantId, (c) => searchCustomersForAi(c, ctx(s.tenantId, { channel: "whatsapp" }), { name: "bh" }));
      const byPhone = await tx(s.tenantId, (c) => searchCustomersForAi(c, ctx(s.tenantId, { channel: "whatsapp" }), { phone: "+919811100001" }));
      const found = [...byName.customers, ...byPhone.customers];
      assert.equal(found.length, 0, `unverified lookup returned ${found.map((f) => `${f.displayName} ${f.phoneMasked} upcoming=${f.hasUpcomingBooking}`).join("; ")}`);
    },
  );

  test("[GUARD] LIKE metacharacters in a name query are escaped (no wildcard dump)", async () => {
    const s = await seedSalon();
    for (const q of ["%%", "__", "\\%"]) {
      const r = await tx(s.tenantId, (c) => searchCustomersForAi(c, ctx(s.tenantId, { channel: "whatsapp" }), { name: q }));
      assert.equal(r.customers.length, 0, `query ${JSON.stringify(q)} matched customers`);
    }
  });

  test("[GUARD] the AI search never returns full phone, full email, notes, or more than 5 rows", async () => {
    const s = await seedSalon();
    const r = await tx(s.tenantId, (c) => searchCustomersForAi(c, ctx(s.tenantId, { channel: "whatsapp" }), { name: "an" }));
    const text = JSON.stringify(r);
    assert.ok(!text.includes("+919811100001") && !text.includes("alice@example.com"));
    assert.ok(r.customers.length <= 5);
  });
});

describe("customer matching on confirm_booking", () => {
  test(
    "[DEFECT SEC-009] confirming with a new phone and an e-mail that belongs to another customer gives a mapped, non-revealing error (today: raw 23505 -> HTTP 500)",
    { todo: "SEC-009: after migration 014 the insert violates customers_active_email_unique; engine-bookings does not map 23505 and looks customers up by phone only" },
    async () => {
      const s = await seedSalon();
      const dash = ctx(s.tenantId, { channel: "web_chat" });
      const h = await tx(s.tenantId, (c) => createHold(c, dash, { startsAt: iso(MON_10 + 8 * 86_400_000), catalogueItemId: s.serviceId, resourceId: s.staffA }));
      let err: unknown;
      try {
        await tx(s.tenantId, (c) =>
          confirmBooking(c, dash, { bookingId: h.booking.id, customer: { name: "Mallory", phone: "+919811100999", email: "alice@example.com" } }),
        );
      } catch (e) {
        err = e;
      }
      // Acceptable outcomes: success (reused or ignored the e-mail) or an AppError. A raw driver error is an unhandled 500 and an oracle for "this e-mail is a customer".
      assert.ok(err === undefined || err instanceof AppError, `raw database error escaped the engine: code=${(err as { code?: string })?.code} constraint=${(err as { constraint?: string })?.constraint}`);
    },
  );
});

describe("orders: ownership, money and discount rules", () => {
  async function seedRestaurant() {
    const tenantId = await mkTenant("restaurant", "rest");
    return tx(tenantId, async (c) => {
      const t = { tenant_id: tenantId };
      await insert(c, "locations", { ...t, name: "Main", is_default: true });
      const asha = await insert(c, "customers", { ...t, name: "Asha Rao", phone: "+919822200001" });
      const bala = await insert(c, "customers", { ...t, name: "Bala Iyer", phone: "+919822200002" });
      const item = await insert(c, "catalogue_items", { ...t, kind: "product", name: "Paneer tikka", base_price_paise: 10000, tax_rate_bps: 500 });
      return { tenantId, asha, bala, item };
    });
  }

  test(
    "[DEFECT SEC-007] cancelOrder from a customer channel is refused unless the order belongs to the verified contact (fail-closed)",
    { todo: "SEC-007: the ownership check runs only if the caller passes onBehalfOfCustomerId; leaving it out skips the check" },
    async () => {
      const r = await seedRestaurant();
      const dash = ctx(r.tenantId, { channel: "dashboard" });
      const draft = await tx(r.tenantId, (c) => createOrderDraft(c, dash, { items: [{ catalogueItemId: r.item, quantity: 2 }], customerId: r.asha }));
      await tx(r.tenantId, (c) => placeOrder(c, dash, { orderId: draft.id }));
      const wa = ctx(r.tenantId, { channel: "whatsapp", actorId: "cred-whatsapp" });
      let status = "";
      try {
        status = (await tx(r.tenantId, (c) => cancelOrder(c, wa, { orderId: draft.id }))).status;
      } catch {
        status = "refused";
      }
      assert.equal(status, "refused", `order of Asha ended up ${status} after a WhatsApp call with no verified contact`);
    },
  );

  test("[GUARD] with onBehalfOfCustomerId set, another customer's order looks absent", async () => {
    const r = await seedRestaurant();
    const dash = ctx(r.tenantId, { channel: "dashboard" });
    const draft = await tx(r.tenantId, (c) => createOrderDraft(c, dash, { items: [{ catalogueItemId: r.item, quantity: 1 }], customerId: r.asha }));
    await assert.rejects(
      tx(r.tenantId, (c) => cancelOrder(c, ctx(r.tenantId, { channel: "whatsapp" }), { orderId: draft.id, onBehalfOfCustomerId: r.bala })),
      (e: AppError) => e.code === "NOT_FOUND",
    );
  });

  test("[GUARD] prices, quantities and totals cannot be set by the caller", async () => {
    const r = await seedRestaurant();
    const cc = ctx(r.tenantId, { channel: "web_chat" });
    await assert.rejects(tx(r.tenantId, (c) => createOrderDraft(c, cc, { items: [{ catalogueItemId: r.item, quantity: 1, unitPricePaise: 1 }] } as never)), (e: AppError) => e.code === "VALIDATION_FAILED");
    for (const quantity of [0, -1, 1000, 1.5]) {
      await assert.rejects(tx(r.tenantId, (c) => createOrderDraft(c, cc, { items: [{ catalogueItemId: r.item, quantity }] })), (e: AppError) => e.code === "VALIDATION_FAILED", `quantity ${quantity}`);
    }
    await assert.rejects(tx(r.tenantId, (c) => createOrderDraft(c, cc, { items: [{ catalogueItemId: r.item, quantity: 1 }], totalPaise: 1 } as never)), (e: AppError) => e.code === "VALIDATION_FAILED");
  });

  test("[GUARD] discount above the cap needs capOverride; never above the subtotal", async () => {
    const r = await seedRestaurant();
    const dash = ctx(r.tenantId, { channel: "dashboard" });
    const d = await tx(r.tenantId, (c) => createOrderDraft(c, dash, { items: [{ catalogueItemId: r.item, quantity: 1 }], customerId: r.asha }));
    await assert.rejects(
      tx(r.tenantId, (c) => applyDiscount(c, dash, { orderId: d.id, expectedVersion: d.version, kind: "percent", bps: 5000 })),
      (e: AppError) => e.code === "FORBIDDEN",
    );
    await assert.rejects(
      tx(r.tenantId, (c) => applyDiscount(c, dash, { orderId: d.id, expectedVersion: d.version, kind: "fixed", amountPaise: 99_999_999, capOverride: true })),
      (e: AppError) => e.code === "VALIDATION_FAILED",
    );
  });

  test("[GUARD] overpayment, over-refund and parallel refunds cannot create money", async () => {
    const r = await seedRestaurant();
    const dash = ctx(r.tenantId, { channel: "dashboard" });
    const d = await tx(r.tenantId, (c) => createOrderDraft(c, dash, { items: [{ catalogueItemId: r.item, quantity: 1 }], customerId: r.asha }));
    const placed = await tx(r.tenantId, (c) => placeOrder(c, dash, { orderId: d.id }));
    await assert.rejects(tx(r.tenantId, (c) => recordPayment(c, dash, { orderId: d.id, amountPaise: placed.totalPaise + 1, method: "cash" })), (e: AppError) => e.code === "CONFLICT");
    await tx(r.tenantId, (c) => recordPayment(c, dash, { orderId: d.id, amountPaise: placed.totalPaise, method: "cash" }));
    // two refunds of the full amount at once: exactly one may succeed (row lock on the order)
    const results = await Promise.allSettled([1, 2].map(() => tx(r.tenantId, (c) => recordRefund(c, dash, { orderId: d.id, amountPaise: placed.totalPaise, method: "cash" }))));
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  });
});
