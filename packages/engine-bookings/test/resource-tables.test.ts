// Time off, breaks and service eligibility read from resource_time_off / resource_breaks / resource_services.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ErrorCode } from "@qenbel/shared";
import { checkAvailability, createHold, rescheduleBooking, sqlAvailabilityDataSource } from "../src/index.ts";
import {
  addBreak,
  addTimeOff,
  allowServices,
  at,
  book,
  connect,
  ctxFor,
  expectAppError,
  insert,
  MONDAY,
  rowsOf,
  seedSalon,
  tx,
  type Env,
  type Salon,
} from "./helpers.ts";

let env: Env;
before(async () => {
  env = await connect();
});
after(async () => {
  await env.close();
});

const window = { from: new Date(at(-24 * 60)), to: new Date(at(48 * 60)), fromDate: MONDAY, toDate: "2031-01-07" };

async function summary(s: Salon, index = 0) {
  const ctx = ctxFor(s.tenantId);
  const [r] = await tx(env, ctx, (c) => sqlAvailabilityDataSource.listResources(c, ctx, { resourceIds: [s.resourceIds[index] as string], allowedTypes: ["staff"], fallbackTimezone: "Asia/Kolkata" }));
  assert.ok(r, "resource summary");
  return r;
}

describe("time off", () => {
  test("blocks slots and holds; deleting the row opens them again", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    const r = s.resourceIds[0] as string;
    const offId = await tx(env, ctx, (c) => addTimeOff(c, s.tenantId, r, at(0), at(10 * 60))); // the whole day
    const closed = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: MONDAY, catalogueItemId: s.serviceId }));
    assert.equal(closed.slots.length, 0);
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(60), catalogueItemId: s.serviceId, resourceId: r })),
      ErrorCode.BOOKING_SLOT_TAKEN,
    );
    await tx(env, ctx, (c) => c.query("delete from resource_time_off where id = $1", [offId]));
    const open = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: MONDAY, catalogueItemId: s.serviceId }));
    assert.equal(open.slots.length, 37);
    await tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(60), catalogueItemId: s.serviceId, resourceId: r }));
  });

  test("only that resource is blocked; another resource of the tenant stays bookable", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => addTimeOff(c, s.tenantId, s.resourceIds[0] as string, at(0), at(10 * 60)));
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: MONDAY, catalogueItemId: s.serviceId }));
    assert.deepEqual(r.resources.map((x) => [x.resourceId, x.slots.length]).sort(), [[s.resourceIds[0], 0], [s.resourceIds[1], 37]].sort());
  });

  test("a reschedule into time off is refused and the booking stays where it was", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    const b = await book(env, s, { minutes: 0 });
    await tx(env, ctx, (c) => addTimeOff(c, s.tenantId, s.resourceIds[0] as string, at(240), at(300)));
    await expectAppError(
      tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(240), expectedVersion: b.version })),
      ErrorCode.BOOKING_SLOT_TAKEN,
    );
    const [row] = await rowsOf<{ starts_at: Date }>(env, s.tenantId, "select starts_at from bookings where id = $1", [b.id]);
    assert.equal(row?.starts_at.toISOString(), at(0));
  });

  test("loadInputs returns only rows that overlap the window, as ISO instants", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    const r = s.resourceIds[0] as string;
    await tx(env, ctx, async (c) => {
      await addTimeOff(c, s.tenantId, r, at(60), at(120));
      await addTimeOff(c, s.tenantId, r, at(-5000), at(-4000));
    });
    const [inputs] = await tx(env, ctx, async (c) => sqlAvailabilityDataSource.loadInputs(c, ctx, [await summary(s)], window));
    assert.deepEqual(inputs?.timeOff, [{ start: at(60), end: at(120) }]);
    assert.equal(inputs?.unreadable, false);
  });
});

describe("breaks", () => {
  test("rows are read per weekday as HH:MM; none means 'use the pack breaks'", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, async (c) => {
      await addBreak(c, s.tenantId, s.resourceIds[0] as string, "13:00", "14:00", [1, 2]);
      await addBreak(c, s.tenantId, s.resourceIds[0] as string, "16:30", "17:00", [1]);
    });
    const inputs = await tx(env, ctx, async (c) =>
      sqlAvailabilityDataSource.loadInputs(c, ctx, [await summary(s, 0), await summary(s, 1)], window),
    );
    assert.deepEqual(inputs[0]?.breaks, [
      { weekday: 1, start: "13:00", end: "14:00" },
      { weekday: 1, start: "16:30", end: "17:00" },
      { weekday: 2, start: "13:00", end: "14:00" },
    ]);
    assert.equal(inputs[1]?.breaks, null);
  });

  test("a tenant break setting still applies to a resource without break rows", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, async (c) => {
      await c.query(`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{bookings}', '{"breaks":[{"start":"12:00","end":"13:00"}]}'::jsonb) where id = $1`, [s.tenantId]);
      await addBreak(c, s.tenantId, s.resourceIds[1] as string, "15:00", "16:00");
    });
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: MONDAY, catalogueItemId: s.serviceId }));
    const slots = (id: string) => r.resources.find((x) => x.resourceId === id)?.slots.map((x) => x.startsAt) ?? [];
    assert.ok(!slots(s.resourceIds[0] as string).includes(at(150)), "12:30 is inside the tenant break for resource A");
    assert.ok(slots(s.resourceIds[0] as string).includes(at(300)), "15:00 is fine for resource A");
    assert.ok(slots(s.resourceIds[1] as string).includes(at(150)), "resource B's own breaks replace the tenant's");
    assert.ok(!slots(s.resourceIds[1] as string).includes(at(315)), "15:15 is inside B's own break");
  });
});

describe("service eligibility", () => {
  test("rows narrow a resource to those services; no rows means any service", async () => {
    const s = await seedSalon(env, { resources: 3 });
    const ctx = ctxFor(s.tenantId);
    const colour = await tx(env, ctx, (c) => insert(c, "catalogue_items", { tenant_id: s.tenantId, kind: "service", name: "Colour", base_price_paise: 9000, duration_minutes: 60 }));
    const [onlyColour, both, anything] = s.resourceIds as [string, string, string];
    await tx(env, ctx, async (c) => {
      await allowServices(c, s.tenantId, onlyColour, [colour]);
      await allowServices(c, s.tenantId, both, [colour, s.serviceId]);
    });
    const haircut = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: MONDAY, catalogueItemId: s.serviceId }));
    assert.deepEqual(haircut.resources.map((r) => r.resourceId).sort(), [both, anything].sort());
    const dye = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: MONDAY, catalogueItemId: colour }));
    assert.equal(dye.resources.length, 3);
  });

  test("an explicit resource that does not serve the service is refused by hold and reschedule", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    const colour = await tx(env, ctx, (c) => insert(c, "catalogue_items", { tenant_id: s.tenantId, kind: "service", name: "Colour", base_price_paise: 9000, duration_minutes: 60 }));
    const b = await book(env, s, { minutes: 0, resourceId: s.resourceIds[0] as string });
    await tx(env, ctx, (c) => allowServices(c, s.tenantId, s.resourceIds[1] as string, [colour]));
    await expectAppError(
      tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(120), catalogueItemId: s.serviceId, resourceId: s.resourceIds[1] as string })),
      ErrorCode.VALIDATION_FAILED,
      (e) => assert.equal(e.details.reason, "resource_not_eligible"),
    );
    await expectAppError(
      tx(env, ctx, (c) => rescheduleBooking(c, ctx, { bookingId: b.id, startsAt: at(120), resourceId: s.resourceIds[1] as string, expectedVersion: b.version })),
      ErrorCode.VALIDATION_FAILED,
      (e) => assert.equal(e.details.reason, "resource_not_eligible"),
    );
  });

  test("a hold without a service is not restricted by resource_services", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    const colour = await tx(env, ctx, (c) => insert(c, "catalogue_items", { tenant_id: s.tenantId, kind: "service", name: "Colour", base_price_paise: 9000, duration_minutes: 60 }));
    await tx(env, ctx, (c) => allowServices(c, s.tenantId, s.resourceIds[0] as string, [colour]));
    const h = await tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(0), durationMinutes: 30, resourceId: s.resourceIds[0] as string }));
    assert.equal(h.booking.status, "HOLD");
  });
});

describe("tenant isolation of the new tables", () => {
  test("another tenant's time off, breaks and services are invisible and have no effect", async () => {
    const a = await seedSalon(env, { resources: 1 });
    const b = await seedSalon(env, { resources: 1 });
    const ctxA = ctxFor(a.tenantId);
    const ctxB = ctxFor(b.tenantId);
    const colour = await tx(env, ctxA, (c) => insert(c, "catalogue_items", { tenant_id: a.tenantId, kind: "service", name: "Colour", base_price_paise: 9000, duration_minutes: 60 }));
    await tx(env, ctxA, async (c) => {
      await addTimeOff(c, a.tenantId, a.resourceIds[0] as string, at(0), at(10 * 60));
      await addBreak(c, a.tenantId, a.resourceIds[0] as string, "13:00", "14:00");
      await allowServices(c, a.tenantId, a.resourceIds[0] as string, [colour]);
    });

    // Tenant B's own resource is untouched.
    const rb = await tx(env, ctxB, (c) => checkAvailability(c, ctxB, { from: MONDAY, catalogueItemId: b.serviceId }));
    assert.equal(rb.slots.length, 37);
    // Tenant B asking for tenant A's resource by id: it does not exist for B; the data source returns nothing and loads no rows.
    const asked = await tx(env, ctxB, (c) =>
      sqlAvailabilityDataSource.listResources(c, ctxB, { resourceIds: [a.resourceIds[0] as string], catalogueItemId: colour, allowedTypes: ["staff"], fallbackTimezone: "Asia/Kolkata" }),
    );
    assert.deepEqual(asked, []);
    const foreign = await summary(a);
    const loaded = await tx(env, ctxB, (c) => sqlAvailabilityDataSource.loadInputs(c, ctxB, [foreign], window));
    assert.equal(loaded[0]?.timeOff.length, 0);
    assert.equal(loaded[0]?.breaks, null);
    await expectAppError(
      tx(env, ctxB, (c) => createHold(c, ctxB, { startsAt: at(0), catalogueItemId: b.serviceId, resourceId: a.resourceIds[0] as string })),
      ErrorCode.NOT_FOUND,
    );
    // Row-Level Security on the tables themselves, even when the query forgets its tenant filter.
    for (const table of ["resource_time_off", "resource_breaks", "resource_services"]) {
      const [n] = await rowsOf<{ n: string }>(env, b.tenantId, `select count(*) n from ${table}`);
      assert.equal(n?.n, "0", `${table} is empty for tenant B`);
    }
    // And tenant A still sees its own rows.
    const ra = await tx(env, ctxA, (c) => checkAvailability(c, ctxA, { from: MONDAY, catalogueItemId: a.serviceId }));
    assert.equal(ra.slots.length, 0);
  });
});
