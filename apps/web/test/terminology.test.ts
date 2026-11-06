import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNav } from "../src/nav.ts";
import { DEFAULT_TERMINOLOGY, EXAMPLE_TERMINOLOGY, buildTerminology, copy, terminologyForPack } from "../src/terminology.ts";
import { getPackOption, listPackOptions } from "../src/packs.ts";

const labels = (id: string | null) => {
  const pack = getPackOption(id);
  return buildNav(pack?.terminology ?? DEFAULT_TERMINOLOGY, pack?.modules).map((n) => n.label);
};

test("default terminology gives the generic nav", () => {
  assert.deepEqual(labels(null), ["Dashboard", "Bookings", "Orders", "Customers", "Catalogue", "Resources", "Settings"]);
});

test("a clinic reads Doctors and Appointments, and has no orders screen", () => {
  const t = terminologyForPack("clinic");
  assert.equal(t.resources, "Doctors");
  assert.equal(t.bookings, "Appointments");
  assert.equal(t.customers, "Patients");
  const nav = labels("clinic");
  assert.ok(nav.includes("Doctors") && nav.includes("Appointments") && nav.includes("Patients"));
  assert.ok(!nav.includes("Orders"), "clinic has orderMode none");
});

test("a restaurant reads Tables, Reservations and Kitchen", () => {
  const nav = labels("restaurant");
  assert.ok(nav.includes("Tables"));
  assert.ok(nav.includes("Reservations"));
  assert.ok(nav.includes("Kitchen"));
  const t = terminologyForPack("restaurant");
  assert.equal(t.orderStatusLabels.PROCESSING, "Preparing");
  assert.equal(t.ordersNoun, "Orders", "sentences say orders even though the screen is called Kitchen");
});

test("a salon reads Stylists and Appointments", () => {
  const t = terminologyForPack("salon");
  assert.equal(t.resources, "Stylists");
  assert.equal(t.bookings, "Appointments");
});

test("unknown or missing pack falls back to the defaults", () => {
  assert.deepEqual(terminologyForPack("nope"), DEFAULT_TERMINOLOGY);
  assert.deepEqual(terminologyForPack(null), DEFAULT_TERMINOLOGY);
  assert.deepEqual(buildTerminology(undefined), DEFAULT_TERMINOLOGY);
});

test("every example map only uses known terminology keys and non-empty words", () => {
  const known = new Set(Object.keys(DEFAULT_TERMINOLOGY));
  for (const [id, overrides] of Object.entries(EXAMPLE_TERMINOLOGY)) {
    for (const [key, value] of Object.entries(overrides)) {
      assert.ok(known.has(key), `${id}: unknown key ${key}`);
      if (typeof value === "string") assert.ok(value.trim().length > 0, `${id}.${key} is empty`);
    }
    // The nav is complete for every example.
    const t = buildTerminology(overrides);
    for (const item of buildNav(t)) assert.ok(item.label.length > 0);
  }
});

test("routes do not change with the words", () => {
  const paths = (id: string | null) => buildNav(terminologyForPack(id)).map((n) => n.to);
  assert.deepEqual(paths("restaurant"), paths(null));
  assert.deepEqual(paths("clinic"), paths(null));
});

test("pack options each carry words and module flags", () => {
  const packs = listPackOptions();
  assert.ok(packs.length >= 3);
  assert.equal(new Set(packs.map((p) => p.id)).size, packs.length);
  for (const p of packs) {
    assert.ok(p.label && p.description);
    assert.equal(typeof p.modules.bookings, "boolean");
    assert.equal(typeof p.modules.orders, "boolean");
  }
});

test("page copy is plain: no prices, promises or hype", () => {
  const banned = /(₹|\$|£|€|\bINR\b|\bfree\b|\bguarantee|\bbest\b|\bfastest\b|\bunlimited\b|within \d+ (hours|days)|!)/i;
  for (const id of [null, "salon", "clinic", "restaurant"]) {
    const t = terminologyForPack(id);
    const c = copy(t);
    const samples = [
      c.emptyTitle(t.bookings), c.emptyText(t.orders), c.newBooking, c.newOrder, c.newCustomer, c.newItem, c.newResource,
      ...Object.values(t).filter((v): v is string => typeof v === "string"),
    ];
    for (const s of samples) assert.ok(!banned.test(s), `banned wording in "${s}"`);
  }
});
