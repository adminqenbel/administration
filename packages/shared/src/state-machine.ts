// Generic state machine helper plus the default booking and order machines (ARCHITECTURE.md section 5).
import { BookingStatus, OrderStatus } from "./enums.ts";
import { AppError, ErrorCode } from "./errors.ts";

export interface Machine<S extends string> {
  readonly initial: S;
  /** Every state is a key. Terminal states map to an empty list. */
  readonly transitions: Readonly<Record<S, readonly S[]>>;
  readonly states: readonly S[];
}

export interface MachineDefinition<S extends string> {
  initial: S;
  /** States with no entry (or only listed as targets) are terminal. */
  transitions: Partial<Record<S, readonly S[]>>;
}

export function defineMachine<S extends string>(def: MachineDefinition<S>): Machine<S> {
  const states = new Set<S>([def.initial]);
  for (const [from, targets] of Object.entries(def.transitions) as [S, readonly S[] | undefined][]) {
    states.add(from);
    for (const to of targets ?? []) states.add(to);
  }
  const transitions = {} as Record<S, readonly S[]>;
  for (const s of states) {
    const targets = def.transitions[s] ?? [];
    const unique = [...new Set(targets)];
    transitions[s] = Object.freeze(unique);
  }
  return Object.freeze({
    initial: def.initial,
    transitions: Object.freeze(transitions),
    states: Object.freeze([...states]),
  });
}

export function canTransition<S extends string>(machine: Machine<S>, from: S, to: S): boolean {
  return Object.hasOwn(machine.transitions, from) && machine.transitions[from].includes(to);
}

export function allowedTransitions<S extends string>(machine: Machine<S>, from: S): readonly S[] {
  return Object.hasOwn(machine.transitions, from) ? machine.transitions[from] : [];
}

export function isTerminal<S extends string>(machine: Machine<S>, state: S): boolean {
  return Object.hasOwn(machine.transitions, state) && machine.transitions[state].length === 0;
}

/** Throws AppError(INVALID_TRANSITION) when `from -> to` is not allowed. */
export function assertTransition<S extends string>(machine: Machine<S>, from: S, to: S, entity = "record"): void {
  if (!canTransition(machine, from, to)) {
    throw new AppError(ErrorCode.INVALID_TRANSITION, undefined, {
      entity,
      from,
      to,
      allowed: [...allowedTransitions(machine, from)],
    });
  }
}

/** States reachable from `initial`, including `initial`. */
export function reachableStates<S extends string>(machine: Machine<S>): Set<S> {
  const seen = new Set<S>([machine.initial]);
  const queue: S[] = [machine.initial];
  while (queue.length > 0) {
    const s = queue.shift() as S;
    for (const t of machine.transitions[s] ?? []) {
      if (!seen.has(t)) {
        seen.add(t);
        queue.push(t);
      }
    }
  }
  return seen;
}

/** Every edge of `sub` exists in `base` (narrowing is allowed, widening is not). Returns the offending edges. */
export function extraTransitions<S extends string>(sub: Machine<S>, base: Machine<S>): [S, S][] {
  const extra: [S, S][] = [];
  for (const from of sub.states) {
    for (const to of sub.transitions[from] ?? []) {
      if (!canTransition(base, from, to)) extra.push([from, to]);
    }
  }
  return extra;
}

const B = BookingStatus;
const O = OrderStatus;

export const DEFAULT_BOOKING_TRANSITIONS = {
  [B.HOLD]: [B.CONFIRMED, B.EXPIRED, B.CANCELLED],
  [B.CONFIRMED]: [B.CONFIRMED, B.CHECKED_IN, B.CANCELLED, B.NO_SHOW],
  [B.CHECKED_IN]: [B.COMPLETED],
  [B.COMPLETED]: [],
  [B.CANCELLED]: [],
  [B.EXPIRED]: [],
  [B.NO_SHOW]: [],
} as const satisfies Record<BookingStatus, readonly BookingStatus[]>;

/** CONFIRMED -> CONFIRMED is a reschedule (version bump). */
export const bookingMachine: Machine<BookingStatus> = defineMachine<BookingStatus>({
  initial: B.HOLD,
  transitions: DEFAULT_BOOKING_TRANSITIONS,
});

/** ARCHITECTURE.md section 5. REFUNDED is reachable from FULFILLED only; see CONTRACT-REQUESTS for the "(paid)" question. */
export const DEFAULT_ORDER_TRANSITIONS = {
  [O.DRAFT]: [O.PLACED, O.CANCELLED],
  [O.PLACED]: [O.ACCEPTED, O.REJECTED, O.CANCELLED],
  [O.ACCEPTED]: [O.PROCESSING, O.CANCELLED],
  [O.PROCESSING]: [O.READY],
  [O.READY]: [O.FULFILLED],
  [O.FULFILLED]: [O.REFUNDED],
  [O.CANCELLED]: [],
  [O.REJECTED]: [],
  [O.REFUNDED]: [],
} as const satisfies Record<OrderStatus, readonly OrderStatus[]>;

export const orderMachine: Machine<OrderStatus> = defineMachine<OrderStatus>({
  initial: O.DRAFT,
  transitions: DEFAULT_ORDER_TRANSITIONS,
});
