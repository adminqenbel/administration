import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppError,
  BookingStatus,
  ErrorCode,
  OrderStatus,
  allowedTransitions,
  assertTransition,
  bookingMachine,
  canTransition,
  defineMachine,
  extraTransitions,
  isTerminal,
  orderMachine,
  reachableStates,
  type Machine,
} from "../src/index.ts";

const B = BookingStatus;
const O = OrderStatus;

const bookingLegal: [string, string][] = [
  [B.HOLD, B.CONFIRMED],
  [B.HOLD, B.EXPIRED],
  [B.HOLD, B.CANCELLED],
  [B.CONFIRMED, B.CONFIRMED], // reschedule
  [B.CONFIRMED, B.CHECKED_IN],
  [B.CONFIRMED, B.CANCELLED],
  [B.CONFIRMED, B.NO_SHOW],
  [B.CHECKED_IN, B.COMPLETED],
];

const orderLegal: [string, string][] = [
  [O.DRAFT, O.PLACED],
  [O.DRAFT, O.CANCELLED],
  [O.PLACED, O.ACCEPTED],
  [O.PLACED, O.REJECTED],
  [O.PLACED, O.CANCELLED],
  [O.ACCEPTED, O.PROCESSING],
  [O.ACCEPTED, O.CANCELLED],
  [O.PROCESSING, O.READY],
  [O.READY, O.FULFILLED],
  [O.FULFILLED, O.REFUNDED],
];

function exhaustive(machine: Machine<string>, legal: [string, string][], all: string[]) {
  const legalKey = new Set(legal.map(([a, b]) => `${a}>${b}`));
  let checked = 0;
  for (const from of all) {
    for (const to of all) {
      const expected = legalKey.has(`${from}>${to}`);
      assert.equal(canTransition(machine, from, to), expected, `${from} -> ${to}`);
      if (expected) {
        assert.doesNotThrow(() => assertTransition(machine, from, to));
      } else {
        assert.throws(
            () => assertTransition(machine, from, to, "thing"),
          (e: unknown) =>
            e instanceof AppError &&
            e.code === ErrorCode.INVALID_TRANSITION &&
            e.details.from === from &&
            e.details.to === to &&
            e.details.entity === "thing" &&
            Array.isArray(e.details.allowed),
        );
      }
      checked++;
    }
  }
  return checked;
}

test("booking machine: every legal and illegal pair", () => {
  const all = Object.values(B);
  assert.equal(exhaustive(bookingMachine as Machine<string>, bookingLegal, all), all.length ** 2);
  assert.equal(bookingMachine.initial, B.HOLD);
  assert.deepEqual([...bookingMachine.states].sort(), [...all].sort());
});

test("order machine: every legal and illegal pair", () => {
  const all = Object.values(O);
  assert.equal(exhaustive(orderMachine as Machine<string>, orderLegal, all), all.length ** 2);
  assert.equal(orderMachine.initial, O.DRAFT);
  assert.deepEqual([...orderMachine.states].sort(), [...all].sort());
});

test("terminal states and reachability", () => {
  for (const s of [B.COMPLETED, B.CANCELLED, B.EXPIRED, B.NO_SHOW]) assert.ok(isTerminal(bookingMachine, s), s);
  for (const s of [B.HOLD, B.CONFIRMED, B.CHECKED_IN]) assert.ok(!isTerminal(bookingMachine, s), s);
  for (const s of [O.CANCELLED, O.REJECTED, O.REFUNDED]) assert.ok(isTerminal(orderMachine, s), s);
  assert.equal(reachableStates(bookingMachine).size, Object.values(B).length);
  assert.equal(reachableStates(orderMachine).size, Object.values(O).length);
});

test("unknown states are never allowed", () => {
  assert.equal(canTransition(bookingMachine as Machine<string>, "BOGUS", B.CONFIRMED), false);
  assert.equal(canTransition(bookingMachine as Machine<string>, B.HOLD, "BOGUS"), false);
  assert.deepEqual(allowedTransitions(bookingMachine as Machine<string>, "BOGUS"), []);
  // prototype keys must not count as states
  assert.equal(canTransition(bookingMachine as Machine<string>, "constructor", B.CONFIRMED), false);
});

test("defineMachine builds a closed map and freezes it", () => {
  const m = defineMachine<"a" | "b" | "c">({ initial: "a", transitions: { a: ["b", "b"], b: ["c"] } });
  assert.deepEqual([...m.states].sort(), ["a", "b", "c"]);
  assert.deepEqual(m.transitions.a, ["b"]);
  assert.deepEqual(m.transitions.c, []);
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.transitions) && Object.isFrozen(m.transitions.a));
  assert.ok(canTransition(m, "a", "b"));
  assert.ok(!canTransition(m, "a", "c"));
  assert.ok(isTerminal(m, "c"));
});

test("extraTransitions finds widening but allows narrowing", () => {
  const narrowed = defineMachine<BookingStatus>({
    initial: B.HOLD,
    transitions: { [B.HOLD]: [B.CONFIRMED], [B.CONFIRMED]: [B.COMPLETED] },
  });
  assert.deepEqual(extraTransitions(narrowed, bookingMachine), [[B.CONFIRMED, B.COMPLETED]]);
  const ok = defineMachine<BookingStatus>({ initial: B.HOLD, transitions: { [B.HOLD]: [B.CONFIRMED] } });
  assert.deepEqual(extraTransitions(ok, bookingMachine), []);
});
