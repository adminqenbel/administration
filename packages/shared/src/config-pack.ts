// Config pack schema (ARCHITECTURE.md section 9) and semantic validation.
import { z } from "zod";
import { BookingMode, BookingStatus, OrderMode, OrderStatus, ResourceType, ToolName } from "./enums.ts";
import { customerFieldSchema } from "./schemas/customer.ts";
import {
  DEFAULT_BOOKING_TRANSITIONS,
  DEFAULT_ORDER_TRANSITIONS,
  bookingMachine,
  canTransition,
  defineMachine,
  extraTransitions,
  orderMachine,
  reachableStates,
  type Machine,
} from "./state-machine.ts";
import { timezoneSchema, weeklyHoursSchema } from "./time.ts";

// ---- vocab ---------------------------------------------------------------

export const NotificationTemplateKey = {
  BOOKING_CONFIRMED: "booking_confirmed",
  BOOKING_RESCHEDULED: "booking_rescheduled",
  BOOKING_CANCELLED: "booking_cancelled",
  BOOKING_REMINDER: "booking_reminder",
  ORDER_ACCEPTED: "order_accepted",
  ORDER_READY: "order_ready",
  ORDER_CANCELLED: "order_cancelled",
} as const;
export type NotificationTemplateKey = (typeof NotificationTemplateKey)[keyof typeof NotificationTemplateKey];

/** Placeholders a template may use, written {{name}}. */
export const TEMPLATE_PLACEHOLDERS = [
  "customerName",
  "businessName",
  "startsAt",
  "resourceName",
  "serviceName",
  "partySize",
  "orderRef",
] as const;

export const DashboardWidget = {
  TODAY_BOOKINGS: "today_bookings",
  UPCOMING_BOOKINGS: "upcoming_bookings",
  PENDING_HOLDS: "pending_holds",
  NO_SHOWS: "no_shows",
  RESOURCE_UTILISATION: "resource_utilisation",
  OPEN_ORDERS: "open_orders",
  KITCHEN_QUEUE: "kitchen_queue",
  NEW_CUSTOMERS: "new_customers",
} as const;
export type DashboardWidget = (typeof DashboardWidget)[keyof typeof DashboardWidget];

export const CancellationLate = {
  /** Cancellation after the cutoff is accepted. */
  ALLOW: "allow",
  /** Accepted, and the booking is flagged as a late cancellation. */
  FLAG: "flag",
  /** Refused. The customer is pointed to the business. */
  BLOCK: "block",
} as const;
export type CancellationLate = (typeof CancellationLate)[keyof typeof CancellationLate];

export const BOOKING_TOOLS: readonly ToolName[] = [
  ToolName.CHECK_AVAILABILITY,
  ToolName.CREATE_BOOKING_HOLD,
  ToolName.CONFIRM_BOOKING,
  ToolName.RESCHEDULE_BOOKING,
  ToolName.CANCEL_BOOKING,
];
export const ORDER_TOOLS: readonly ToolName[] = [
  ToolName.GET_ORDER_STATUS,
  ToolName.CREATE_ORDER_DRAFT,
  ToolName.CONFIRM_ORDER,
  ToolName.CANCEL_ORDER,
];

const BOOKING_WIDGETS: readonly DashboardWidget[] = [
  DashboardWidget.TODAY_BOOKINGS,
  DashboardWidget.UPCOMING_BOOKINGS,
  DashboardWidget.PENDING_HOLDS,
  DashboardWidget.NO_SHOWS,
  DashboardWidget.RESOURCE_UTILISATION,
];
const ORDER_WIDGETS: readonly DashboardWidget[] = [DashboardWidget.OPEN_ORDERS, DashboardWidget.KITCHEN_QUEUE];

// ---- schema --------------------------------------------------------------

const word = z.string().trim().min(1).max(40);

export const terminologySchema = z
  .object({
    resource: word,
    resources: word,
    booking: word,
    bookings: word,
    order: word,
    orders: word,
    customer: word,
    customers: word,
    catalogueItem: word,
    catalogueItems: word,
  })
  .strict();
export type Terminology = z.infer<typeof terminologySchema>;

const label = z.string().trim().min(1).max(30);

function transitionSpec<S extends Record<string, string>>(statuses: S) {
  return z
    .object({
      /** Allowed moves, by status. A subset of the default machine. */
      transitions: z.partialRecord(z.enum(statuses), z.array(z.enum(statuses)).max(10)),
      /** Display labels, by status. */
      labels: z.partialRecord(z.enum(statuses), label),
    })
    .strict();
}
export const bookingTransitionsSchema = transitionSpec(BookingStatus);
export const orderTransitionsSchema = transitionSpec(OrderStatus);
export type BookingTransitions = z.infer<typeof bookingTransitionsSchema>;
export type OrderTransitions = z.infer<typeof orderTransitionsSchema>;

const templateSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(320),
  })
  .strict();

export const defaultsSchema = z
  .object({
    timezone: timezoneSchema,
    hours: weeklyHoursSchema,
    holdMinutes: z.number().int().min(1).max(120),
    defaultDurationMinutes: z.number().int().min(5).max(1440),
    stepMinutes: z.number().int().min(5).max(240),
    bufferMinutes: z.number().int().min(0).max(240),
    cancellationPolicy: z
      .object({
        /** Hours before the start after which a cancellation counts as late. */
        cancelUntilHoursBefore: z.number().int().min(0).max(720),
        lateCancellation: z.enum(CancellationLate),
      })
      .strict(),
  })
  .strict();
export type PackDefaults = z.infer<typeof defaultsSchema>;

export const ConfigPack = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    label: z.string().trim().min(1).max(60),
    terminology: terminologySchema,
    bookingMode: z.enum(BookingMode),
    orderMode: z.enum(OrderMode),
    resourceTypes: z.array(z.enum(ResourceType)).max(6),
    requiredCustomerFields: z.array(customerFieldSchema).max(5),
    bookingTransitions: bookingTransitionsSchema,
    orderTransitions: orderTransitionsSchema,
    notificationTemplates: z.partialRecord(z.enum(NotificationTemplateKey), templateSchema),
    aiTools: z.array(z.enum(ToolName)).max(13),
    dashboard: z
      .object({
        widgets: z
          .array(z.object({ id: z.enum(DashboardWidget), label: z.string().trim().min(1).max(40) }).strict())
          .max(8),
      })
      .strict(),
    defaults: defaultsSchema,
  })
  .strict();
export type ConfigPack = z.infer<typeof ConfigPack>;

// ---- semantic validation -------------------------------------------------

export type PackValidation = { ok: true; pack: ConfigPack; errors: [] } | { ok: false; errors: string[] };

const FORBIDDEN_COPY = /₹|\bINR\b|\bRs\b\.?|guarantee/i;
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

function duplicates<T>(list: readonly T[]): T[] {
  return list.filter((v, i) => list.indexOf(v) !== i);
}

function checkMachine<S extends string>(
  errors: string[],
  name: string,
  active: boolean,
  spec: { transitions: Partial<Record<S, readonly S[] | undefined>>; labels: Partial<Record<S, string | undefined>> },
  base: Machine<S>,
  mustHave: [S, S],
): void {
  const cleaned: Partial<Record<S, readonly S[]>> = {};
  for (const [from, to] of Object.entries(spec.transitions) as [S, readonly S[] | undefined][]) {
    if (to !== undefined) cleaned[from] = to;
  }
  const hasEdges = Object.values(cleaned).some((t) => (t as readonly S[]).length > 0);
  if (!active) {
    if (hasEdges) errors.push(`${name}: mode is "none" so transitions must be empty`);
    if (Object.keys(spec.labels).length > 0) errors.push(`${name}: mode is "none" so labels must be empty`);
    return;
  }
  for (const [from, to] of Object.entries(cleaned) as [S, readonly S[]][]) {
    const dup = duplicates(to);
    if (dup.length > 0) errors.push(`${name}: ${from} lists ${dup.join(", ")} more than once`);
  }
  const machine = defineMachine<S>({ initial: base.initial, transitions: cleaned });
  for (const [from, to] of extraTransitions(machine, base)) {
    errors.push(`${name}: ${from} -> ${to} is not in the default machine (packs may narrow, not add)`);
  }
  if (!canTransition(machine, mustHave[0], mustHave[1])) {
    errors.push(`${name}: ${mustHave[0]} -> ${mustHave[1]} is required`);
  }
  // Statuses the pack actually uses: the initial one, and any with an edge in or out.
  // A status narrowed away completely (empty list, never a target) is simply unused.
  const used = new Set<S>([base.initial]);
  for (const [from, to] of Object.entries(cleaned) as [S, readonly S[]][]) {
    if (to.length === 0) continue;
    used.add(from);
    for (const t of to) used.add(t);
  }
  const reachable = reachableStates(machine);
  for (const s of used) {
    if (!reachable.has(s)) errors.push(`${name}: status ${s} is not reachable from ${base.initial}`);
  }
  for (const s of Object.keys(spec.labels) as S[]) {
    if (!used.has(s)) errors.push(`${name}: label for unused status ${s}`);
  }
}

/** Schema check plus cross-field rules. Never throws. */
export function validatePack(input: unknown): PackValidation {
  const parsed = ConfigPack.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(pack)"}: ${i.message}`),
    };
  }
  const pack = parsed.data;
  const errors: string[] = [];

  const bookingActive = pack.bookingMode !== BookingMode.NONE;
  const orderActive = pack.orderMode !== OrderMode.NONE;
  if (!bookingActive && !orderActive) errors.push('bookingMode and orderMode cannot both be "none"');

  checkMachine(errors, "bookingTransitions", bookingActive, pack.bookingTransitions, bookingMachine, [
    BookingStatus.HOLD,
    BookingStatus.CONFIRMED,
  ]);
  checkMachine(errors, "orderTransitions", orderActive, pack.orderTransitions, orderMachine, [
    OrderStatus.DRAFT,
    OrderStatus.PLACED,
  ]);

  // aiTools
  for (const d of new Set(duplicates(pack.aiTools))) errors.push(`aiTools: ${d} is listed more than once`);
  const tools = new Set<ToolName>(pack.aiTools);
  if (!bookingActive) {
    for (const t of BOOKING_TOOLS) if (tools.has(t)) errors.push(`aiTools: ${t} needs a bookingMode other than "none"`);
  }
  if (!orderActive) {
    for (const t of ORDER_TOOLS) if (tools.has(t)) errors.push(`aiTools: ${t} needs an orderMode other than "none"`);
  }
  if (tools.has(ToolName.CONFIRM_BOOKING) && !tools.has(ToolName.CREATE_BOOKING_HOLD)) {
    errors.push("aiTools: confirm_booking needs create_booking_hold");
  }
  if (tools.has(ToolName.CREATE_BOOKING_HOLD) && !tools.has(ToolName.CHECK_AVAILABILITY)) {
    errors.push("aiTools: create_booking_hold needs check_availability");
  }
  if (tools.has(ToolName.CONFIRM_ORDER) && !tools.has(ToolName.CREATE_ORDER_DRAFT)) {
    errors.push("aiTools: confirm_order needs create_order_draft");
  }

  // resource types vs modes
  for (const d of new Set(duplicates(pack.resourceTypes))) errors.push(`resourceTypes: ${d} is listed more than once`);
  const rt = new Set<ResourceType>(pack.resourceTypes);
  const has = (...types: ResourceType[]) => types.some((t) => rt.has(t));
  if (pack.bookingMode === BookingMode.TABLE && !rt.has(ResourceType.TABLE)) {
    errors.push('bookingMode "table" needs resourceType "table"');
  }
  if (pack.bookingMode === BookingMode.ROOM && !rt.has(ResourceType.ROOM)) {
    errors.push('bookingMode "room" needs resourceType "room"');
  }
  if (pack.bookingMode === BookingMode.SLOT && !has(ResourceType.STAFF, ResourceType.DOCTOR, ResourceType.ROOM, ResourceType.EQUIPMENT)) {
    errors.push('bookingMode "slot" needs resourceType staff, doctor, room or equipment');
  }
  if (pack.bookingMode === BookingMode.PERIOD && !has(ResourceType.VEHICLE, ResourceType.EQUIPMENT, ResourceType.ROOM)) {
    errors.push('bookingMode "period" needs resourceType vehicle, equipment or room');
  }
  if (pack.orderMode === OrderMode.DINE_IN && !rt.has(ResourceType.TABLE)) {
    errors.push('orderMode "dine_in" needs resourceType "table"');
  }
  if (pack.orderMode === OrderMode.RENTAL && !has(ResourceType.VEHICLE, ResourceType.EQUIPMENT, ResourceType.ROOM)) {
    errors.push('orderMode "rental" needs resourceType vehicle, equipment or room');
  }

  // customer fields
  for (const d of new Set(duplicates(pack.requiredCustomerFields))) {
    errors.push(`requiredCustomerFields: ${d} is listed more than once`);
  }

  // notification templates
  const allowed = new Set<string>(TEMPLATE_PLACEHOLDERS);
  for (const [key, tpl] of Object.entries(pack.notificationTemplates)) {
    if (!tpl) continue;
    if (key.startsWith("booking_") && !bookingActive) errors.push(`notificationTemplates.${key}: bookings are off`);
    if (key.startsWith("order_") && !orderActive) errors.push(`notificationTemplates.${key}: orders are off`);
    for (const field of ["title", "body"] as const) {
      const text = tpl[field];
      for (const m of text.matchAll(PLACEHOLDER_RE)) {
        if (!allowed.has(m[1] as string)) errors.push(`notificationTemplates.${key}.${field}: unknown placeholder {{${m[1]}}}`);
      }
      const stripped = text.replace(PLACEHOLDER_RE, "");
      if (stripped.includes("{{") || stripped.includes("}}")) {
        errors.push(`notificationTemplates.${key}.${field}: malformed placeholder`);
      }
      if (FORBIDDEN_COPY.test(text)) errors.push(`notificationTemplates.${key}.${field}: no prices or guarantees in copy`);
    }
  }

  // dashboard
  const widgetIds = pack.dashboard.widgets.map((w) => w.id);
  for (const d of new Set(duplicates(widgetIds))) errors.push(`dashboard.widgets: ${d} is listed more than once`);
  for (const id of widgetIds) {
    if (!bookingActive && BOOKING_WIDGETS.includes(id)) errors.push(`dashboard.widgets: ${id} needs bookings`);
    if (!orderActive && ORDER_WIDGETS.includes(id)) errors.push(`dashboard.widgets: ${id} needs orders`);
    if (id === DashboardWidget.KITCHEN_QUEUE && pack.orderMode !== OrderMode.DINE_IN) {
      errors.push('dashboard.widgets: kitchen_queue needs orderMode "dine_in"');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, pack, errors: [] };
}

/** Parse and validate, or throw. For registry load and onboarding. */
export function parsePack(input: unknown): ConfigPack {
  const result = validatePack(input);
  if (!result.ok) {
    throw new Error(`Invalid config pack: ${result.errors.join("; ")}`);
  }
  return result.pack;
}

// Helpers for pack authors: a mutable copy of the default edges, optionally narrowed.
function copyTransitions<S extends string>(
  base: Readonly<Record<S, readonly S[]>>,
  remove: readonly (readonly [S, S])[],
): Partial<Record<S, S[]>> {
  const out: Partial<Record<S, S[]>> = {};
  for (const from of Object.keys(base) as S[]) {
    out[from] = base[from].filter((to) => !remove.some(([f, t]) => f === from && t === to));
  }
  return out;
}

/** Default booking transitions minus the listed edges. */
export function bookingTransitionsWithout(
  ...remove: (readonly [BookingStatus, BookingStatus])[]
): BookingTransitions["transitions"] {
  return copyTransitions<BookingStatus>(DEFAULT_BOOKING_TRANSITIONS, remove);
}

/** Default order transitions minus the listed edges. */
export function orderTransitionsWithout(
  ...remove: (readonly [OrderStatus, OrderStatus])[]
): OrderTransitions["transitions"] {
  return copyTransitions<OrderStatus>(DEFAULT_ORDER_TRANSITIONS, remove);
}
