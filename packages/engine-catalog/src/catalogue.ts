// Catalogue: categories, items (service | product), variants, prices in integer paise, tax in basis points.
import { z } from "zod";
import { AppError, CatalogueItemKind, ErrorCode, ResourceType } from "@qenbel/shared";
import {
  SetBuilder, assertRef, count, cursorSchema, decodeCursor, idArg, isoReq, iso, likeEscape, limitSchema, notFound, op, paise, staffOp, text, toPage,
  type EngineContext, type SqlClient,
} from "./common.ts";

// ---- schemas -----------------------------------------------------------------------------------------

/** Integer paise only. A decimal or a numeric string is refused. */
export const paiseInput = z.number().int().min(0).max(100_000_000_000);
const currencyInput = z.string().regex(/^[A-Z]{3}$/, "Use a 3 letter currency code such as INR");
const kindInput = z.enum(Object.values(CatalogueItemKind) as [string, ...string[]]);
const resourceTypeInput = z.enum(Object.values(ResourceType) as [string, ...string[]]);
const archivedFilter = z.enum(["exclude", "include", "only"]).default("exclude");
const attrsInput = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.union([text(0, 500), z.number().finite(), z.boolean()]))
  .refine((r) => Object.keys(r).length <= 20, "At most 20 attributes");

const itemFields = {
  name: text(1, 200),
  description: text(1, 4000),
  categoryId: idArg,
  sku: text(1, 64),
  amountPaise: paiseInput,
  currency: currencyInput,
  durationMinutes: z.number().int().min(1).max(1440),
  bufferMinutes: z.number().int().min(0).max(1440),
  taxRateBps: z.number().int().min(0).max(10_000),
  requiredResourceType: resourceTypeInput,
  attributes: attrsInput,
  available: z.boolean(),
  sortOrder: z.number().int().min(-100000).max(100000),
};

const createItemInput = z
  .object({
    kind: kindInput,
    name: itemFields.name,
    description: itemFields.description.optional(),
    categoryId: itemFields.categoryId.optional(),
    sku: itemFields.sku.optional(),
    amountPaise: itemFields.amountPaise,
    currency: itemFields.currency.default("INR"),
    durationMinutes: itemFields.durationMinutes.optional(),
    bufferMinutes: itemFields.bufferMinutes.default(0),
    taxRateBps: itemFields.taxRateBps.default(0),
    requiredResourceType: itemFields.requiredResourceType.optional(),
    attributes: itemFields.attributes.optional(),
    available: itemFields.available.default(true),
    sortOrder: itemFields.sortOrder.default(0),
  })
  .strict();

const updateItemInput = z
  .object({
    itemId: idArg,
    name: itemFields.name.optional(),
    description: itemFields.description.nullable().optional(),
    categoryId: itemFields.categoryId.nullable().optional(),
    sku: itemFields.sku.nullable().optional(),
    amountPaise: itemFields.amountPaise.optional(),
    currency: itemFields.currency.optional(),
    durationMinutes: itemFields.durationMinutes.nullable().optional(),
    bufferMinutes: itemFields.bufferMinutes.optional(),
    taxRateBps: itemFields.taxRateBps.optional(),
    requiredResourceType: itemFields.requiredResourceType.nullable().optional(),
    attributes: itemFields.attributes.optional(),
    available: itemFields.available.optional(),
    sortOrder: itemFields.sortOrder.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, "Provide at least one field to change");

const itemIdInput = z.object({ itemId: idArg }).strict();

const listItemsInput = z
  .object({
    kind: kindInput.optional(),
    categoryId: idArg.optional(),
    query: text(1, 100).optional(),
    available: z.boolean().optional(),
    archived: archivedFilter,
    limit: limitSchema,
    cursor: cursorSchema,
  })
  .strict();

// ---- DTOs --------------------------------------------------------------------------------------------

export interface VariantDto {
  id: string;
  itemId: string;
  name: string;
  sku: string | null;
  amountPaise: number;
  durationMinutes: number | null;
  sortOrder: number;
  active: boolean;
}

export interface ItemDto {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  sku: string | null;
  amountPaise: number;
  currency: string;
  durationMinutes: number | null;
  bufferMinutes: number;
  taxRateBps: number;
  requiredResourceType: string | null;
  attributes: Record<string, unknown>;
  available: boolean;
  sortOrder: number;
  archivedAt: string | null;
  variants: VariantDto[];
  createdAt: string;
  updatedAt: string;
}

interface ItemRow {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  category_id: string | null;
  category_name: string | null;
  sku: string | null;
  base_price_paise: string;
  currency: string;
  duration_minutes: number | null;
  buffer_minutes: number;
  tax_rate_bps: number;
  required_resource_type: string | null;
  attributes: Record<string, unknown> | null;
  available: boolean;
  sort_order: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  name_key: string;
}

interface VariantRow {
  id: string;
  item_id: string;
  name: string;
  sku: string | null;
  price_paise: string;
  duration_minutes: number | null;
  sort_order: number;
  active: boolean;
}

const ITEM_COLS = `i.id, i.kind, i.name, i.description, i.category_id, cat.name as category_name, i.sku, i.base_price_paise, i.currency,
  i.duration_minutes, i.buffer_minutes, i.tax_rate_bps, i.required_resource_type, i.attributes, i.available, i.sort_order,
  i.archived_at, i.created_at, i.updated_at, lower(i.name) as name_key`;
const ITEM_FROM = `catalogue_items i left join catalogue_categories cat on cat.tenant_id = i.tenant_id and cat.id = i.category_id`;

const toVariant = (r: VariantRow): VariantDto => ({
  id: r.id, itemId: r.item_id, name: r.name, sku: r.sku, amountPaise: paise(r.price_paise),
  durationMinutes: r.duration_minutes, sortOrder: r.sort_order, active: r.active,
});

async function loadVariants(sql: SqlClient, ctx: EngineContext, itemIds: string[], activeOnly: boolean): Promise<Map<string, VariantDto[]>> {
  const map = new Map<string, VariantDto[]>();
  if (itemIds.length === 0) return map;
  const res = await sql.query<VariantRow>(
    `select id, item_id, name, sku, price_paise, duration_minutes, sort_order, active from catalogue_variants
      where tenant_id = $1 and item_id = any($2::uuid[]) and ($3::boolean = false or active)
      order by sort_order, lower(name), id`,
    [ctx.tenantId, itemIds, activeOnly],
  );
  for (const r of res.rows) {
    const list = map.get(r.item_id) ?? [];
    list.push(toVariant(r));
    map.set(r.item_id, list);
  }
  return map;
}

async function hydrate(sql: SqlClient, ctx: EngineContext, rows: ItemRow[]): Promise<ItemDto[]> {
  const variants = await loadVariants(sql, ctx, rows.map((r) => r.id), false);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    categoryId: r.category_id,
    categoryName: r.category_name,
    sku: r.sku,
    amountPaise: paise(r.base_price_paise),
    currency: r.currency,
    durationMinutes: r.duration_minutes,
    bufferMinutes: r.buffer_minutes,
    taxRateBps: r.tax_rate_bps,
    requiredResourceType: r.required_resource_type,
    attributes: r.attributes ?? {},
    available: r.available,
    sortOrder: r.sort_order,
    archivedAt: iso(r.archived_at),
    variants: variants.get(r.id) ?? [],
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  }));
}

async function loadItem(sql: SqlClient, ctx: EngineContext, id: string): Promise<ItemDto> {
  const res = await sql.query<ItemRow>(`select ${ITEM_COLS} from ${ITEM_FROM} where i.tenant_id = $1 and i.id = $2`, [ctx.tenantId, id]);
  const row = res.rows[0];
  if (!row) throw notFound("Catalogue item");
  return (await hydrate(sql, ctx, [row]))[0] as ItemDto;
}

function checkKindRules(kind: string, durationMinutes: number | null | undefined, requiredResourceType: string | null | undefined): void {
  if (kind === CatalogueItemKind.SERVICE && (durationMinutes === null || durationMinutes === undefined)) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "A service needs a duration in minutes.", { issues: [{ path: "durationMinutes", message: "Required for a service" }] });
  }
  if (kind === CatalogueItemKind.PRODUCT && durationMinutes !== null && durationMinutes !== undefined) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "A product has no duration.", { issues: [{ path: "durationMinutes", message: "Not allowed for a product" }] });
  }
  if (kind === CatalogueItemKind.PRODUCT && requiredResourceType !== null && requiredResourceType !== undefined) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "A product does not need a resource.", { issues: [{ path: "requiredResourceType", message: "Not allowed for a product" }] });
  }
}

// ---- items -------------------------------------------------------------------------------------------

export const createCatalogueItem = staffOp(createItemInput, async (sql, ctx, input): Promise<ItemDto> => {
  checkKindRules(input.kind, input.durationMinutes, input.requiredResourceType);
  if (input.categoryId) await assertRef(sql, ctx, "catalogue_categories", input.categoryId, "categoryId");
  const res = await sql.query<{ id: string }>(
    `insert into catalogue_items (tenant_id, category_id, kind, name, description, sku, base_price_paise, currency, duration_minutes,
                                  buffer_minutes, tax_rate_bps, required_resource_type, attributes, available, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15) returning id`,
    [
      ctx.tenantId, input.categoryId ?? null, input.kind, input.name, input.description ?? null, input.sku ?? null, input.amountPaise,
      input.currency, input.durationMinutes ?? null, input.bufferMinutes, input.taxRateBps, input.requiredResourceType ?? null,
      JSON.stringify(input.attributes ?? {}), input.available, input.sortOrder,
    ],
  );
  return loadItem(sql, ctx, (res.rows[0] as { id: string }).id);
});

export const getCatalogueItem = staffOp(itemIdInput, (sql, ctx, input) => loadItem(sql, ctx, input.itemId));

export const updateCatalogueItem = staffOp(updateItemInput, async (sql, ctx, input): Promise<ItemDto> => {
  const cur = await sql.query<ItemRow>(`select ${ITEM_COLS} from ${ITEM_FROM} where i.tenant_id = $1 and i.id = $2 for update of i`, [ctx.tenantId, input.itemId]);
  const row = cur.rows[0];
  if (!row) throw notFound("Catalogue item");
  if (row.archived_at) throw new AppError(ErrorCode.CONFLICT, "Restore this item before changing it.");
  const duration = input.durationMinutes === undefined ? row.duration_minutes : input.durationMinutes;
  const reqType = input.requiredResourceType === undefined ? row.required_resource_type : input.requiredResourceType;
  checkKindRules(row.kind, duration, reqType);
  if (input.categoryId) await assertRef(sql, ctx, "catalogue_categories", input.categoryId, "categoryId");

  const set = new SetBuilder([ctx.tenantId, input.itemId]);
  if (input.name !== undefined) set.set("name", input.name);
  if (input.description !== undefined) set.set("description", input.description);
  if (input.categoryId !== undefined) set.set("category_id", input.categoryId);
  if (input.sku !== undefined) set.set("sku", input.sku);
  if (input.amountPaise !== undefined) set.set("base_price_paise", input.amountPaise);
  if (input.currency !== undefined) set.set("currency", input.currency);
  if (input.durationMinutes !== undefined) set.set("duration_minutes", input.durationMinutes);
  if (input.bufferMinutes !== undefined) set.set("buffer_minutes", input.bufferMinutes);
  if (input.taxRateBps !== undefined) set.set("tax_rate_bps", input.taxRateBps);
  if (input.requiredResourceType !== undefined) set.set("required_resource_type", input.requiredResourceType);
  if (input.attributes !== undefined) set.set("attributes", JSON.stringify(input.attributes), "::jsonb");
  if (input.available !== undefined) set.set("available", input.available);
  if (input.sortOrder !== undefined) set.set("sort_order", input.sortOrder);
  await sql.query(`update catalogue_items set ${set.clause} where tenant_id = $1 and id = $2`, set.values);
  return loadItem(sql, ctx, input.itemId);
});

/** Soft delete. Idempotent. Past bookings and orders keep pointing at the item. */
export const archiveCatalogueItem = staffOp(itemIdInput, async (sql, ctx, input): Promise<ItemDto> => {
  const res = await sql.query("update catalogue_items set archived_at = coalesce(archived_at, $3) where tenant_id = $1 and id = $2 returning id", [
    ctx.tenantId, input.itemId, ctx.now(),
  ]);
  if (res.rows.length === 0) throw notFound("Catalogue item");
  return loadItem(sql, ctx, input.itemId);
});

/** Undo archive. CONFLICT if another live item now has the same SKU. */
export const restoreCatalogueItem = staffOp(itemIdInput, async (sql, ctx, input): Promise<ItemDto> => {
  const res = await sql.query("update catalogue_items set archived_at = null where tenant_id = $1 and id = $2 returning id", [ctx.tenantId, input.itemId]);
  if (res.rows.length === 0) throw notFound("Catalogue item");
  return loadItem(sql, ctx, input.itemId);
});

export const listCatalogueItems = staffOp(listItemsInput, async (sql, ctx, input) => {
  const cur = decodeCursor(input.cursor, 3);
  const where = ["i.tenant_id = $1"];
  const params: unknown[] = [ctx.tenantId];
  const add = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  if (input.archived === "exclude") where.push("i.archived_at is null");
  if (input.archived === "only") where.push("i.archived_at is not null");
  if (input.kind) where.push(`i.kind = ${add(input.kind)}`);
  if (input.categoryId) where.push(`i.category_id = ${add(input.categoryId)}`);
  if (input.available !== undefined) where.push(`i.available = ${add(input.available)}`);
  if (input.query) {
    const like = add(`%${likeEscape(input.query.toLowerCase())}%`);
    where.push(`(lower(i.name) like ${like} escape '\\' or lower(coalesce(i.description, '')) like ${like} escape '\\')`);
  }
  if (cur) where.push(`(i.sort_order, lower(i.name), i.id) > (${add(Number(cur[0]))}::int, ${add(cur[1])}, ${add(cur[2])}::uuid)`);
  const limitP = add(input.limit + 1);
  const res = await sql.query<ItemRow>(
    `select ${ITEM_COLS} from ${ITEM_FROM} where ${where.join(" and ")} order by i.sort_order, lower(i.name), i.id limit ${limitP}`,
    params,
  );
  const page = toPage(res.rows, input.limit, (r) => [String(r.sort_order), r.name_key, r.id]);
  return { items: await hydrate(sql, ctx, page.items), nextCursor: page.nextCursor };
});

// ---- variants ----------------------------------------------------------------------------------------

const variantFields = {
  name: text(1, 200),
  sku: text(1, 64),
  amountPaise: paiseInput,
  durationMinutes: z.number().int().min(1).max(1440),
  sortOrder: z.number().int().min(-100000).max(100000),
  active: z.boolean(),
};

async function loadVariant(sql: SqlClient, ctx: EngineContext, id: string): Promise<VariantDto> {
  const res = await sql.query<VariantRow>(
    "select id, item_id, name, sku, price_paise, duration_minutes, sort_order, active from catalogue_variants where tenant_id = $1 and id = $2",
    [ctx.tenantId, id],
  );
  const row = res.rows[0];
  if (!row) throw notFound("Variant");
  return toVariant(row);
}

export const createVariant = staffOp(
  z
    .object({
      itemId: idArg,
      name: variantFields.name,
      sku: variantFields.sku.optional(),
      amountPaise: variantFields.amountPaise,
      durationMinutes: variantFields.durationMinutes.optional(),
      sortOrder: variantFields.sortOrder.default(0),
      active: variantFields.active.default(true),
    })
    .strict(),
  async (sql, ctx, input): Promise<VariantDto> => {
    const item = await sql.query<{ kind: string; archived_at: Date | null }>(
      "select kind, archived_at from catalogue_items where tenant_id = $1 and id = $2 for update",
      [ctx.tenantId, input.itemId],
    );
    const row = item.rows[0];
    if (!row) throw notFound("Catalogue item");
    if (row.archived_at) throw new AppError(ErrorCode.CONFLICT, "Restore this item before changing it.");
    if (row.kind === CatalogueItemKind.PRODUCT && input.durationMinutes !== undefined) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, "A product variant has no duration.");
    }
    const res = await sql.query<{ id: string }>(
      `insert into catalogue_variants (tenant_id, item_id, name, sku, price_paise, duration_minutes, sort_order, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [ctx.tenantId, input.itemId, input.name, input.sku ?? null, input.amountPaise, input.durationMinutes ?? null, input.sortOrder, input.active],
    );
    return loadVariant(sql, ctx, (res.rows[0] as { id: string }).id);
  },
);

/** Variants are deactivated (`active: false`), never deleted: past orders and bookings refer to them. */
export const updateVariant = staffOp(
  z
    .object({
      variantId: idArg,
      name: variantFields.name.optional(),
      sku: variantFields.sku.nullable().optional(),
      amountPaise: variantFields.amountPaise.optional(),
      durationMinutes: variantFields.durationMinutes.nullable().optional(),
      sortOrder: variantFields.sortOrder.optional(),
      active: variantFields.active.optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 1, "Provide at least one field to change"),
  async (sql, ctx, input): Promise<VariantDto> => {
    const set = new SetBuilder([ctx.tenantId, input.variantId]);
    if (input.name !== undefined) set.set("name", input.name);
    if (input.sku !== undefined) set.set("sku", input.sku);
    if (input.amountPaise !== undefined) set.set("price_paise", input.amountPaise);
    if (input.durationMinutes !== undefined) set.set("duration_minutes", input.durationMinutes);
    if (input.sortOrder !== undefined) set.set("sort_order", input.sortOrder);
    if (input.active !== undefined) set.set("active", input.active);
    const res = await sql.query(`update catalogue_variants set ${set.clause} where tenant_id = $1 and id = $2 returning id`, set.values);
    if (res.rows.length === 0) throw notFound("Variant");
    return loadVariant(sql, ctx, input.variantId);
  },
);

export const listVariants = staffOp(z.object({ itemId: idArg, includeInactive: z.boolean().default(false) }).strict(), async (sql, ctx, input) => {
  await assertRef(sql, ctx, "catalogue_items", input.itemId, "itemId");
  return (await loadVariants(sql, ctx, [input.itemId], !input.includeInactive)).get(input.itemId) ?? [];
});

// ---- categories --------------------------------------------------------------------------------------

export interface CategoryDto {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  active: boolean;
  itemCount: number;
}

interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  active: boolean;
  item_count: string;
}

const toCategory = (r: CategoryRow): CategoryDto => ({
  id: r.id, parentId: r.parent_id, name: r.name, sortOrder: r.sort_order, active: r.active, itemCount: count(r.item_count),
});

async function loadCategory(sql: SqlClient, ctx: EngineContext, id: string): Promise<CategoryDto> {
  const res = await sql.query<CategoryRow>(
    `select c.id, c.parent_id, c.name, c.sort_order, c.active,
            (select count(*) from catalogue_items i where i.tenant_id = c.tenant_id and i.category_id = c.id and i.archived_at is null) as item_count
       from catalogue_categories c where c.tenant_id = $1 and c.id = $2`,
    [ctx.tenantId, id],
  );
  const row = res.rows[0];
  if (!row) throw notFound("Category");
  return toCategory(row);
}

export const createCategory = staffOp(
  z
    .object({ name: text(1, 200), parentId: idArg.optional(), sortOrder: z.number().int().min(-100000).max(100000).default(0), active: z.boolean().default(true) })
    .strict(),
  async (sql, ctx, input): Promise<CategoryDto> => {
    if (input.parentId) await assertRef(sql, ctx, "catalogue_categories", input.parentId, "parentId");
    const res = await sql.query<{ id: string }>(
      "insert into catalogue_categories (tenant_id, parent_id, name, sort_order, active) values ($1, $2, $3, $4, $5) returning id",
      [ctx.tenantId, input.parentId ?? null, input.name, input.sortOrder, input.active],
    );
    return loadCategory(sql, ctx, (res.rows[0] as { id: string }).id);
  },
);

export const updateCategory = staffOp(
  z
    .object({
      categoryId: idArg,
      name: text(1, 200).optional(),
      parentId: idArg.nullable().optional(),
      sortOrder: z.number().int().min(-100000).max(100000).optional(),
      active: z.boolean().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 1, "Provide at least one field to change"),
  async (sql, ctx, input): Promise<CategoryDto> => {
    const exists = await sql.query("select 1 from catalogue_categories where tenant_id = $1 and id = $2 for update", [ctx.tenantId, input.categoryId]);
    if (exists.rows.length === 0) throw notFound("Category");
    if (input.parentId) {
      await assertRef(sql, ctx, "catalogue_categories", input.parentId, "parentId");
      // A category cannot sit under itself or under one of its own descendants.
      const loop = await sql.query(
        `with recursive up as (
           select id, parent_id from catalogue_categories where tenant_id = $1 and id = $2
           union all
           select c.id, c.parent_id from catalogue_categories c join up on c.id = up.parent_id where c.tenant_id = $1
         ) select 1 from up where id = $3 limit 1`,
        [ctx.tenantId, input.parentId, input.categoryId],
      );
      if (loop.rows.length > 0) throw new AppError(ErrorCode.CONFLICT, "A category cannot be placed under itself.");
    }
    const set = new SetBuilder([ctx.tenantId, input.categoryId]);
    if (input.name !== undefined) set.set("name", input.name);
    if (input.parentId !== undefined) set.set("parent_id", input.parentId);
    if (input.sortOrder !== undefined) set.set("sort_order", input.sortOrder);
    if (input.active !== undefined) set.set("active", input.active);
    await sql.query(`update catalogue_categories set ${set.clause} where tenant_id = $1 and id = $2`, set.values);
    return loadCategory(sql, ctx, input.categoryId);
  },
);

export const listCategories = staffOp(z.object({}).strict(), async (sql, ctx): Promise<CategoryDto[]> => {
  const res = await sql.query<CategoryRow>(
    `select c.id, c.parent_id, c.name, c.sort_order, c.active,
            (select count(*) from catalogue_items i where i.tenant_id = c.tenant_id and i.category_id = c.id and i.archived_at is null) as item_count
       from catalogue_categories c where c.tenant_id = $1 order by c.sort_order, lower(c.name), c.id limit 1000`,
    [ctx.tenantId],
  );
  return res.rows.map(toCategory);
});

/** Only an empty category can be removed: no items (archived ones included) and no child categories. */
export const deleteCategory = staffOp(z.object({ categoryId: idArg }).strict(), async (sql, ctx, input): Promise<{ deleted: true }> => {
  const exists = await sql.query("select 1 from catalogue_categories where tenant_id = $1 and id = $2 for update", [ctx.tenantId, input.categoryId]);
  if (exists.rows.length === 0) throw notFound("Category");
  const used = await sql.query<{ items: string; children: string }>(
    `select (select count(*) from catalogue_items where tenant_id = $1 and category_id = $2) as items,
            (select count(*) from catalogue_categories where tenant_id = $1 and parent_id = $2) as children`,
    [ctx.tenantId, input.categoryId],
  );
  const u = used.rows[0] as { items: string; children: string };
  if (count(u.items) > 0 || count(u.children) > 0) {
    throw new AppError(ErrorCode.CONFLICT, "Only an empty category can be deleted.", { items: count(u.items), childCategories: count(u.children) });
  }
  await sql.query("delete from catalogue_categories where tenant_id = $1 and id = $2", [ctx.tenantId, input.categoryId]);
  return { deleted: true };
});

// ---- AI-safe catalogue -------------------------------------------------------------------------------

/** Exactly the fields an AI channel may see. No SKU, tax rate, buffer, attributes, resource rules or timestamps. */
export interface ChannelCatalogueItem {
  catalogueItemId: string;
  name: string;
  kind: string;
  description?: string;
  category?: string;
  amountPaise: number;
  currency: string;
  durationMinutes?: number;
  available: boolean;
  variants?: Array<{ variantId: string; name: string; amountPaise: number; durationMinutes?: number }>;
}

export const CHANNEL_DESCRIPTION_MAX = 1000;

/**
 * Catalogue for AI channels and the public widget. Archived items and items in an inactive category are never
 * returned; only active variants. `available: false` items are listed so the assistant can say they are off for now.
 */
export const getCatalogueForChannel = op(
  z
    .object({
      query: text(1, 100).optional(),
      category: text(1, 60).optional(),
      kind: kindInput.optional(),
      limit: z.number().int().min(1).max(50).default(25),
      cursor: cursorSchema,
    })
    .strict(),
  async (sql, ctx, input): Promise<{ items: ChannelCatalogueItem[]; nextCursor: string | null }> => {
    const cur = decodeCursor(input.cursor, 3);
    const where = ["i.tenant_id = $1", "i.archived_at is null", "(i.category_id is null or cat.active)"];
    const params: unknown[] = [ctx.tenantId];
    const add = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    if (input.kind) where.push(`i.kind = ${add(input.kind)}`);
    if (input.category) where.push(`lower(cat.name) = ${add(input.category.toLowerCase())}`);
    if (input.query) {
      const like = add(`%${likeEscape(input.query.toLowerCase())}%`);
      where.push(`(lower(i.name) like ${like} escape '\\' or lower(coalesce(i.description, '')) like ${like} escape '\\')`);
    }
    if (cur) where.push(`(i.sort_order, lower(i.name), i.id) > (${add(Number(cur[0]))}::int, ${add(cur[1])}, ${add(cur[2])}::uuid)`);
    const limitP = add(input.limit + 1);
    const res = await sql.query<ItemRow>(
      `select ${ITEM_COLS} from ${ITEM_FROM} where ${where.join(" and ")} order by i.sort_order, lower(i.name), i.id limit ${limitP}`,
      params,
    );
    const page = toPage(res.rows, input.limit, (r) => [String(r.sort_order), r.name_key, r.id]);
    const variants = await loadVariants(sql, ctx, page.items.map((r) => r.id), true);
    const items = page.items.map((r): ChannelCatalogueItem => {
      const out: ChannelCatalogueItem = {
        catalogueItemId: r.id,
        name: r.name,
        kind: r.kind,
        amountPaise: paise(r.base_price_paise),
        currency: r.currency,
        available: r.available,
      };
      if (r.description) out.description = r.description.slice(0, CHANNEL_DESCRIPTION_MAX);
      if (r.category_name) out.category = r.category_name;
      if (r.duration_minutes !== null) out.durationMinutes = r.duration_minutes;
      const vs = variants.get(r.id);
      if (vs && vs.length > 0) {
        out.variants = vs.map((v) => {
          const o: { variantId: string; name: string; amountPaise: number; durationMinutes?: number } = { variantId: v.id, name: v.name, amountPaise: v.amountPaise };
          if (v.durationMinutes !== null) o.durationMinutes = v.durationMinutes;
          return o;
        });
      }
      return out;
    });
    return { items, nextCursor: page.nextCursor };
  },
);
