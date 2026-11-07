// Tenant-scoped lookups the order engine needs: catalogue prices (the only source of price), customers,
// bookings and table resources. Every query filters by tenant_id explicitly AND runs under RLS.
import { toPaise } from "@qenbel/db";
import {
  ErrorCode,
  ResourceType,
  type CreateCustomer,
  type CustomerField,
  type EngineContext,
  type Paise,
  type SqlClient,
} from "@qenbel/shared";
import { emitEvent, notFound, orderError } from "./common.ts";
import type { OrderLineInput } from "./schemas.ts";
import type { ItemRow } from "./view.ts";

export interface ResolvedLine {
  catalogueItemId: string;
  variantId: string | null;
  /** Snapshot of the name (item, and variant when chosen) at order time. */
  name: string;
  unitPricePaise: Paise;
  taxRateBps: number;
  currency: string;
  quantity: number;
  note: string | null;
}

interface CatalogueItemRow {
  id: string;
  name: string;
  base_price_paise: string;
  currency: string;
  tax_rate_bps: number;
  available: boolean;
  archived_at: Date | null;
}

interface VariantRow {
  id: string;
  item_id: string;
  name: string;
  price_paise: string;
  active: boolean;
}

const unavailable = (catalogueItemId: string, name: string, variantId?: string) =>
  orderError(ErrorCode.CONFLICT, "ORDER_ITEM_UNAVAILABLE", `${name} is not available.`, {
    catalogueItemId,
    ...(variantId ? { variantId } : {}),
    name,
  });

/**
 * Price lines from the catalogue. The client supplies only ids and quantities. A missing id (or one that belongs to
 * another tenant, which RLS hides) is NOT_FOUND; an archived or unavailable item or an inactive variant is
 * CONFLICT / ORDER_ITEM_UNAVAILABLE naming the item.
 */
export async function resolveLines(sql: SqlClient, ctx: EngineContext, inputs: readonly OrderLineInput[]): Promise<ResolvedLine[]> {
  const itemIds = [...new Set(inputs.map((i) => i.catalogueItemId))];
  const items = await sql.query<CatalogueItemRow>(
    `select id, name, base_price_paise, currency, tax_rate_bps, available, archived_at
       from catalogue_items where tenant_id = $1 and id = any($2::uuid[])`,
    [ctx.tenantId, itemIds],
  );
  const itemById = new Map(items.rows.map((r) => [r.id, r]));

  const variantIds = [...new Set(inputs.flatMap((i) => (i.variantId ? [i.variantId] : [])))];
  const variantById = new Map<string, VariantRow>();
  if (variantIds.length > 0) {
    const variants = await sql.query<VariantRow>(
      "select id, item_id, name, price_paise, active from catalogue_variants where tenant_id = $1 and id = any($2::uuid[])",
      [ctx.tenantId, variantIds],
    );
    for (const v of variants.rows) variantById.set(v.id, v);
  }

  return inputs.map((input) => {
    const item = itemById.get(input.catalogueItemId);
    if (!item) throw notFound("CATALOGUE_ITEM_NOT_FOUND", { catalogueItemId: input.catalogueItemId });
    if (!item.available || item.archived_at !== null) throw unavailable(item.id, item.name);
    let name = item.name;
    let price = item.base_price_paise;
    if (input.variantId) {
      const variant = variantById.get(input.variantId);
      if (!variant || variant.item_id !== item.id) {
        throw notFound("CATALOGUE_VARIANT_NOT_FOUND", { catalogueItemId: item.id, variantId: input.variantId });
      }
      if (!variant.active) throw unavailable(item.id, item.name, variant.id);
      name = `${item.name} - ${variant.name}`;
      price = variant.price_paise;
    }
    return {
      catalogueItemId: item.id,
      variantId: input.variantId ?? null,
      name: name.slice(0, 200),
      unitPricePaise: toPaise(price),
      taxRateBps: item.tax_rate_bps,
      currency: item.currency,
      quantity: input.quantity,
      note: input.note && input.note.length > 0 ? input.note : null,
    };
  });
}

/** At placement: every stored line must still be orderable. Prices are NOT refreshed (they are snapshots). */
export async function assertLinesStillOrderable(sql: SqlClient, ctx: EngineContext, items: readonly ItemRow[]): Promise<void> {
  const itemIds = [...new Set(items.flatMap((i) => (i.catalogue_item_id ? [i.catalogue_item_id] : [])))];
  if (itemIds.length === 0) return;
  const res = await sql.query<CatalogueItemRow>(
    "select id, name, base_price_paise, currency, tax_rate_bps, available, archived_at from catalogue_items where tenant_id = $1 and id = any($2::uuid[])",
    [ctx.tenantId, itemIds],
  );
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  const variantIds = [...new Set(items.flatMap((i) => (i.variant_id ? [i.variant_id] : [])))];
  const variantById = new Map<string, VariantRow>();
  if (variantIds.length > 0) {
    const v = await sql.query<VariantRow>(
      "select id, item_id, name, price_paise, active from catalogue_variants where tenant_id = $1 and id = any($2::uuid[])",
      [ctx.tenantId, variantIds],
    );
    for (const row of v.rows) variantById.set(row.id, row);
  }
  for (const line of items) {
    if (!line.catalogue_item_id) continue;
    const item = byId.get(line.catalogue_item_id);
    if (!item || !item.available || item.archived_at !== null) throw unavailable(line.catalogue_item_id, line.name);
    if (line.variant_id) {
      const variant = variantById.get(line.variant_id);
      if (!variant || !variant.active) throw unavailable(line.catalogue_item_id, line.name, line.variant_id);
    }
  }
}

// ---- customers --------------------------------------------------------------------------------------------

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  attributes: Record<string, unknown>;
}

export async function requireCustomer(sql: SqlClient, ctx: EngineContext, customerId: string): Promise<CustomerRow> {
  const res = await sql.query<CustomerRow>(
    "select id, name, phone, email, attributes from customers where tenant_id = $1 and id = $2 and archived_at is null",
    [ctx.tenantId, customerId],
  );
  const row = res.rows[0];
  if (!row) throw notFound("CUSTOMER_NOT_FOUND");
  return row;
}

/** E.164 for the database CHECK. Ten digits are taken as Indian mobile numbers. */
export function toE164(phone: string): string | null {
  const digits = phone.replace(/^\+/, "");
  let e164: string;
  if (phone.startsWith("+")) e164 = `+${digits}`;
  else if (/^[6-9]\d{9}$/.test(digits)) e164 = `+91${digits}`;
  else e164 = `+${digits}`;
  return /^\+[1-9][0-9]{6,14}$/.test(e164) ? e164 : null;
}

/**
 * Inline customer on confirm_order: reuse an existing customer with the same phone (or email), else create one and
 * queue customer.created. An existing customer is never modified from here.
 */
export async function findOrCreateCustomer(sql: SqlClient, ctx: EngineContext, input: CreateCustomer): Promise<CustomerRow> {
  const phone = input.phone === undefined ? null : toE164(input.phone);
  if (input.phone !== undefined && phone === null) {
    throw orderError(ErrorCode.VALIDATION_FAILED, "PHONE_INVALID", "Enter a phone number with country code.");
  }
  if (phone !== null) {
    const hit = await sql.query<CustomerRow>(
      "select id, name, phone, email, attributes from customers where tenant_id = $1 and phone = $2 and archived_at is null order by created_at limit 1",
      [ctx.tenantId, phone],
    );
    if (hit.rows[0]) return hit.rows[0];
  } else if (input.email !== undefined) {
    const hit = await sql.query<CustomerRow>(
      "select id, name, phone, email, attributes from customers where tenant_id = $1 and lower(email) = $2 and archived_at is null order by created_at limit 1",
      [ctx.tenantId, input.email],
    );
    if (hit.rows[0]) return hit.rows[0];
  }
  const attributes: Record<string, unknown> = {};
  if (input.dateOfBirth !== undefined) attributes.dateOfBirth = input.dateOfBirth;
  if (input.address !== undefined) attributes.address = input.address;
  const id = ctx.newId();
  await sql.query(
    `insert into customers (id, tenant_id, name, phone, email, source, attributes)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [id, ctx.tenantId, input.name, phone, input.email ?? null, ctx.actor.channel, JSON.stringify(attributes)],
  );
  if (input.notes) {
    await sql.query("insert into customer_notes (tenant_id, customer_id, body) values ($1, $2, $3)", [ctx.tenantId, id, input.notes]);
  }
  await emitEvent(sql, ctx, "customer.created", {
    aggregateType: "customer",
    aggregateId: id,
    payload: { customerId: id, source: ctx.actor.channel, occurredAt: ctx.now().toISOString() },
  });
  return { id, name: input.name, phone, email: input.email ?? null, attributes };
}

/** Pack-required customer fields that are empty. */
export function missingCustomerFields(required: readonly CustomerField[], customer: CustomerRow | null): CustomerField[] {
  if (customer === null) return [...required];
  const has = (field: CustomerField): boolean => {
    switch (field) {
      case "name":
        return customer.name.trim().length > 0;
      case "phone":
        return !!customer.phone;
      case "email":
        return !!customer.email;
      case "dateOfBirth":
        return typeof customer.attributes?.dateOfBirth === "string" && customer.attributes.dateOfBirth.length > 0;
      case "address":
        return typeof customer.attributes?.address === "string" && customer.attributes.address.length > 0;
      default:
        return false;
    }
  };
  return required.filter((f) => !has(f));
}

// ---- bookings and resources -------------------------------------------------------------------------------

/** A booking this order may link to. Orders and bookings stay separate records; this only checks it is ours. */
export async function requireBooking(sql: SqlClient, ctx: EngineContext, bookingId: string): Promise<{ id: string; customerId: string | null }> {
  const res = await sql.query<{ id: string; customer_id: string | null }>(
    "select id, customer_id from bookings where tenant_id = $1 and id = $2",
    [ctx.tenantId, bookingId],
  );
  const row = res.rows[0];
  if (!row) throw notFound("BOOKING_NOT_FOUND");
  return { id: row.id, customerId: row.customer_id };
}

export async function requireTable(sql: SqlClient, ctx: EngineContext, resourceId: string): Promise<{ id: string; name: string }> {
  const res = await sql.query<{ id: string; name: string; type: string; active: boolean; archived_at: Date | null }>(
    "select id, name, type, active, archived_at from resources where tenant_id = $1 and id = $2",
    [ctx.tenantId, resourceId],
  );
  const row = res.rows[0];
  if (!row || row.archived_at !== null || !row.active) throw notFound("RESOURCE_NOT_FOUND");
  if (row.type !== ResourceType.TABLE) {
    throw orderError(ErrorCode.VALIDATION_FAILED, "RESOURCE_NOT_A_TABLE", "That resource is not a table.");
  }
  return { id: row.id, name: row.name };
}

export async function defaultLocationId(sql: SqlClient, ctx: EngineContext): Promise<string | null> {
  const res = await sql.query<{ id: string }>(
    "select id from locations where tenant_id = $1 and active order by is_default desc, created_at limit 1",
    [ctx.tenantId],
  );
  return res.rows[0]?.id ?? null;
}
