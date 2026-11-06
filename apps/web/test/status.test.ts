import { test } from "node:test";
import assert from "node:assert/strict";
import { BookingStatus, OrderStatus } from "../../../packages/shared/src/enums.ts";
import { BOOKING_STATUSES, BOOKING_TONES, ORDER_STATUSES, ORDER_TONES, statusLabels } from "../src/status.ts";
import { terminologyForPack } from "../src/terminology.ts";

test("status lists match the contract enums exactly", () => {
  assert.deepEqual([...BOOKING_STATUSES].sort(), Object.values(BookingStatus).sort());
  assert.deepEqual([...ORDER_STATUSES].sort(), Object.values(OrderStatus).sort());
});

test("every status has a tone and a plain label", () => {
  for (const s of BOOKING_STATUSES) assert.ok(BOOKING_TONES[s], `booking tone ${s}`);
  for (const s of ORDER_STATUSES) assert.ok(ORDER_TONES[s], `order tone ${s}`);
  for (const [, label] of Object.entries(statusLabels([...BOOKING_STATUSES, ...ORDER_STATUSES]))) {
    assert.ok(!label.includes("_") && label !== label.toUpperCase(), `raw-looking label ${label}`);
  }
});

test("a pack may relabel a status but not add one", () => {
  const t = terminologyForPack("restaurant");
  const labels = statusLabels(ORDER_STATUSES, t.orderStatusLabels);
  assert.equal(labels.PROCESSING, "Preparing");
  assert.equal(labels.PLACED, "Placed");
  assert.deepEqual(Object.keys(labels).sort(), [...ORDER_STATUSES].sort());
  for (const t2 of ["salon", "clinic", "restaurant"]) {
    const x = terminologyForPack(t2);
    for (const k of Object.keys(x.bookingStatusLabels)) assert.ok((BOOKING_STATUSES as readonly string[]).includes(k), `${t2}: ${k}`);
    for (const k of Object.keys(x.orderStatusLabels)) assert.ok((ORDER_STATUSES as readonly string[]).includes(k), `${t2}: ${k}`);
  }
});
