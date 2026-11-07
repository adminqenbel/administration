import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveCatalogueItem, createCatalogueItem, createCategory, createVariant, deleteCategory, getCatalogueForChannel, getCatalogueItem,
  listCatalogueItems, listCategories, listVariants, restoreCatalogueItem, updateCatalogueItem, updateCategory, updateVariant,
} from "../src/index.ts";
import { call, connectTestDb, makeCtx, rejectsWith, tx, type TestDb } from "./helpers.ts";

let db: TestDb;
before(async () => {
  db = await connectTestDb();
});
after(async () => {
  await db.close();
});

const ghost = "11111111-1111-1111-1111-111111111111";
const service = (extra: Record<string, unknown> = {}) => ({ kind: "service", name: "Haircut", amountPaise: 50000, durationMinutes: 30, ...extra });
const product = (extra: Record<string, unknown> = {}) => ({ kind: "product", name: "Shampoo", amountPaise: 29900, ...extra });

describe("items", () => {
  test("a service and a product are stored with integer paise, basis points and defaults", async () => {
    const t = await db.createTenant("cat-create");
    const ctx = makeCtx(t);
    const s = await call(db, ctx, createCatalogueItem, service({ description: "Wash and cut", sku: "HC-1", taxRateBps: 1800, bufferMinutes: 10, requiredResourceType: "staff", attributes: { level: "senior" } }) as never);
    assert.equal(s.kind, "service");
    assert.equal(s.amountPaise, 50000);
    assert.equal(s.currency, "INR");
    assert.equal(s.durationMinutes, 30);
    assert.equal(s.bufferMinutes, 10);
    assert.equal(s.taxRateBps, 1800);
    assert.equal(s.requiredResourceType, "staff");
    assert.equal(s.available, true);
    assert.equal(s.archivedAt, null);
    assert.deepEqual(s.attributes, { level: "senior" });
    const p = await call(db, ctx, createCatalogueItem, product() as never);
    assert.equal(p.kind, "product");
    assert.equal(p.durationMinutes, null);
    assert.equal(p.taxRateBps, 0);
    assert.equal(typeof p.amountPaise, "number");
  });

  test("money must be an integer number of paise: decimals, strings, negatives, huge and non-finite values are refused", async () => {
    const t = await db.createTenant("cat-money");
    const ctx = makeCtx(t);
    for (const bad of [499.5, 0.1, "500", "5e2", -1, 1e12, Number.NaN, Infinity, null, undefined, 10n]) {
      await rejectsWith(call(db, ctx, createCatalogueItem, service({ amountPaise: bad }) as never), "VALIDATION_FAILED");
    }
    const ok = await call(db, ctx, createCatalogueItem, service({ name: "Free", amountPaise: 0 }) as never);
    assert.equal(ok.amountPaise, 0);
    const item = await call(db, ctx, createCatalogueItem, service({ name: "Other" }) as never);
    await rejectsWith(call(db, ctx, updateCatalogueItem, { itemId: item.id, amountPaise: 12.34 } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createVariant, { itemId: item.id, name: "V", amountPaise: 1.5 } as never), "VALIDATION_FAILED");
    assert.equal((await call(db, ctx, getCatalogueItem, { itemId: item.id })).amountPaise, 50000, "failed updates change nothing");
  });

  test("kind rules: a service needs a duration, a product has none and needs no resource", async () => {
    const t = await db.createTenant("cat-kind");
    const ctx = makeCtx(t);
    await rejectsWith(call(db, ctx, createCatalogueItem, { kind: "service", name: "No duration", amountPaise: 100 } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCatalogueItem, product({ durationMinutes: 10 }) as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCatalogueItem, product({ requiredResourceType: "staff" }) as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCatalogueItem, service({ durationMinutes: 0 }) as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCatalogueItem, service({ durationMinutes: 1441 }) as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCatalogueItem, service({ taxRateBps: 10001 }) as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCatalogueItem, service({ taxRateBps: 18.5 }) as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCatalogueItem, service({ currency: "inr" }) as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createCatalogueItem, service({ kind: "gift" }) as never), "VALIDATION_FAILED");
    const s = await call(db, ctx, createCatalogueItem, service() as never);
    await rejectsWith(call(db, ctx, updateCatalogueItem, { itemId: s.id, durationMinutes: null }), "VALIDATION_FAILED");
    const p = await call(db, ctx, createCatalogueItem, product() as never);
    await rejectsWith(call(db, ctx, updateCatalogueItem, { itemId: p.id, durationMinutes: 15 }), "VALIDATION_FAILED");
  });

  test("strict input: tenantId and unknown keys are rejected on every write", async () => {
    const t = await db.createTenant("cat-strict");
    const other = await db.createTenant("cat-strict-o");
    const ctx = makeCtx(t);
    const item = await call(db, ctx, createCatalogueItem, service() as never);
    const cat = await call(db, ctx, createCategory, { name: "C" });
    const variant = await call(db, ctx, createVariant, { itemId: item.id, name: "V", amountPaise: 1 });
    for (const smuggle of [{ tenantId: other }, { tenant_id: other }, { role: "OWNER" }]) {
      await rejectsWith(call(db, ctx, createCatalogueItem, { ...service(), ...smuggle } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, ctx, updateCatalogueItem, { itemId: item.id, name: "x", ...smuggle } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, ctx, archiveCatalogueItem, { itemId: item.id, ...smuggle } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, ctx, createCategory, { name: "x", ...smuggle } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, ctx, updateCategory, { categoryId: cat.id, name: "x", ...smuggle } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, ctx, createVariant, { itemId: item.id, name: "x", amountPaise: 1, ...smuggle } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, ctx, updateVariant, { variantId: variant.id, name: "x", ...smuggle } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, ctx, getCatalogueForChannel, { ...smuggle } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, ctx, listCatalogueItems, { ...smuggle } as never), "VALIDATION_FAILED");
    }
  });

  test("update changes only what is given, can clear optional fields, and an archived item must be restored first", async () => {
    const t = await db.createTenant("cat-update");
    const ctx = makeCtx(t);
    const cat = await call(db, ctx, createCategory, { name: "Hair" });
    const s = await call(db, ctx, createCatalogueItem, service({ description: "d", sku: "S1", categoryId: cat.id }) as never);
    const u = await call(db, ctx, updateCatalogueItem, { itemId: s.id, amountPaise: 60000, description: null, sku: null, categoryId: null, available: false });
    assert.equal(u.amountPaise, 60000);
    assert.equal(u.description, null);
    assert.equal(u.sku, null);
    assert.equal(u.categoryId, null);
    assert.equal(u.available, false);
    assert.equal(u.name, "Haircut");
    assert.equal(u.durationMinutes, 30);
    await rejectsWith(call(db, ctx, updateCatalogueItem, { itemId: s.id }), "VALIDATION_FAILED");
    await call(db, ctx, archiveCatalogueItem, { itemId: s.id });
    await rejectsWith(call(db, ctx, updateCatalogueItem, { itemId: s.id, name: "x" }), "CONFLICT");
  });

  test("archive hides, restore brings back, both are idempotent; SKU is unique among live items", async () => {
    const t = await db.createTenant("cat-archive");
    const ctx = makeCtx(t);
    const a = await call(db, ctx, createCatalogueItem, service({ name: "A", sku: "SKU-1" }) as never);
    await rejectsWith(call(db, ctx, createCatalogueItem, service({ name: "B", sku: "SKU-1" }) as never), "CONFLICT");
    const arch = await call(db, ctx, archiveCatalogueItem, { itemId: a.id });
    assert.ok(arch.archivedAt);
    const again = await call(db, ctx, archiveCatalogueItem, { itemId: a.id });
    assert.equal(again.archivedAt, arch.archivedAt);
    const names = async (archived?: string) => (await call(db, ctx, listCatalogueItems, archived ? { archived } as never : {})).items.map((i) => i.name);
    assert.deepEqual(await names(), []);
    assert.deepEqual(await names("include"), ["A"]);
    assert.deepEqual(await names("only"), ["A"]);
    assert.equal((await call(db, ctx, getCatalogueForChannel, {})).items.length, 0);
    assert.equal((await call(db, ctx, getCatalogueItem, { itemId: a.id })).name, "A", "archived items stay readable for history");

    const b = await call(db, ctx, createCatalogueItem, service({ name: "B", sku: "SKU-1" }) as never);
    await rejectsWith(call(db, ctx, restoreCatalogueItem, { itemId: a.id }), "CONFLICT");
    await call(db, ctx, archiveCatalogueItem, { itemId: b.id });
    const back = await call(db, ctx, restoreCatalogueItem, { itemId: a.id });
    assert.equal(back.archivedAt, null);
    assert.equal((await call(db, ctx, restoreCatalogueItem, { itemId: a.id })).archivedAt, null);
    for (const fn of [archiveCatalogueItem, restoreCatalogueItem, getCatalogueItem]) await rejectsWith(call(db, ctx, fn, { itemId: ghost }), "NOT_FOUND");
  });

  test("list filters and pages: kind, category, query (wildcards literal), availability; order by sortOrder then name", async () => {
    const t = await db.createTenant("cat-list");
    const ctx = makeCtx(t);
    const hair = await call(db, ctx, createCategory, { name: "Hair" });
    const spa = await call(db, ctx, createCategory, { name: "Spa" });
    const make = (name: string, extra: Record<string, unknown> = {}) => call(db, ctx, createCatalogueItem, service({ name, ...extra }) as never);
    await make("Zeta cut", { categoryId: hair.id, sortOrder: 1 });
    await make("alpha trim", { categoryId: hair.id, sortOrder: 0 });
    await make("Beta massage", { categoryId: spa.id, sortOrder: 0, description: "Relaxing 100% oil" });
    await make("Gamma facial", { categoryId: spa.id, sortOrder: 0, available: false });
    await call(db, ctx, createCatalogueItem, product({ name: "Serum", sortOrder: 2 }) as never);
    const list = async (q: Record<string, unknown>) => (await call(db, ctx, listCatalogueItems, q as never)).items.map((i) => i.name);
    assert.deepEqual(await list({}), ["alpha trim", "Beta massage", "Gamma facial", "Zeta cut", "Serum"]);
    assert.deepEqual(await list({ kind: "product" }), ["Serum"]);
    assert.deepEqual(await list({ categoryId: spa.id }), ["Beta massage", "Gamma facial"]);
    assert.deepEqual(await list({ available: false }), ["Gamma facial"]);
    assert.deepEqual(await list({ query: "MASSAGE" }), ["Beta massage"]);
    assert.deepEqual(await list({ query: "100%" }), ["Beta massage"]);
    assert.deepEqual(await list({ query: "%" }), ["Beta massage"], "% matches only a literal percent sign");
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await call(db, ctx, listCatalogueItems, { limit: 2, ...(cursor ? { cursor } : {}) } as never);
      seen.push(...p.items.map((i) => i.name));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, ["alpha trim", "Beta massage", "Gamma facial", "Zeta cut", "Serum"]);
    await rejectsWith(call(db, ctx, listCatalogueItems, { cursor: "nonsense" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, listCatalogueItems, { archived: "all" } as never), "VALIDATION_FAILED");
  });
});

describe("variants", () => {
  test("create, update, deactivate; names are unique per item; products have no duration", async () => {
    const t = await db.createTenant("cat-variants");
    const ctx = makeCtx(t);
    const s = await call(db, ctx, createCatalogueItem, service() as never);
    const v1 = await call(db, ctx, createVariant, { itemId: s.id, name: "Long hair", amountPaise: 80000, durationMinutes: 45, sortOrder: 1 });
    const v2 = await call(db, ctx, createVariant, { itemId: s.id, name: "Short hair", amountPaise: 40000 });
    assert.equal(v1.amountPaise, 80000);
    assert.equal(v2.durationMinutes, null);
    await rejectsWith(call(db, ctx, createVariant, { itemId: s.id, name: "Long hair", amountPaise: 1 }), "CONFLICT");
    const up = await call(db, ctx, updateVariant, { variantId: v1.id, amountPaise: 85000, durationMinutes: null });
    assert.equal(up.amountPaise, 85000);
    assert.equal(up.durationMinutes, null);
    await call(db, ctx, updateVariant, { variantId: v2.id, active: false });
    assert.deepEqual((await call(db, ctx, listVariants, { itemId: s.id })).map((v) => v.name), ["Long hair"]);
    assert.equal((await call(db, ctx, listVariants, { itemId: s.id, includeInactive: true })).length, 2);
    assert.equal((await call(db, ctx, getCatalogueItem, { itemId: s.id })).variants.length, 2);
    const p = await call(db, ctx, createCatalogueItem, product() as never);
    await rejectsWith(call(db, ctx, createVariant, { itemId: p.id, name: "Big", amountPaise: 5, durationMinutes: 10 }), "VALIDATION_FAILED");
    await call(db, ctx, archiveCatalogueItem, { itemId: s.id });
    await rejectsWith(call(db, ctx, createVariant, { itemId: s.id, name: "New", amountPaise: 1 }), "CONFLICT");
    await rejectsWith(call(db, ctx, updateVariant, { variantId: ghost, name: "x" }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, createVariant, { itemId: ghost, name: "x", amountPaise: 1 }), "NOT_FOUND");
  });
});

describe("categories", () => {
  test("create, rename, nest, count live items; no cycles; delete only when empty", async () => {
    const t = await db.createTenant("cat-cats");
    const ctx = makeCtx(t);
    const root = await call(db, ctx, createCategory, { name: "Root" });
    const child = await call(db, ctx, createCategory, { name: "Child", parentId: root.id });
    const grand = await call(db, ctx, createCategory, { name: "Grandchild", parentId: child.id });
    await rejectsWith(call(db, ctx, updateCategory, { categoryId: root.id, parentId: grand.id }), "CONFLICT");
    await rejectsWith(call(db, ctx, updateCategory, { categoryId: root.id, parentId: root.id }), "CONFLICT");
    const renamed = await call(db, ctx, updateCategory, { categoryId: child.id, name: "Kid", sortOrder: 5, active: false });
    assert.equal(renamed.name, "Kid");
    assert.equal(renamed.active, false);

    const item = await call(db, ctx, createCatalogueItem, service({ categoryId: grand.id }) as never);
    const list = await call(db, ctx, listCategories, {});
    assert.equal(list.find((c) => c.id === grand.id)?.itemCount, 1);
    assert.equal(list.length, 3);

    const e1 = await rejectsWith(call(db, ctx, deleteCategory, { categoryId: root.id }), "CONFLICT");
    assert.equal(e1.details.childCategories, 1);
    const e2 = await rejectsWith(call(db, ctx, deleteCategory, { categoryId: grand.id }), "CONFLICT");
    assert.equal(e2.details.items, 1);
    await call(db, ctx, archiveCatalogueItem, { itemId: item.id });
    await rejectsWith(call(db, ctx, deleteCategory, { categoryId: grand.id }), "CONFLICT"); // archived items still count
    await call(db, ctx, restoreCatalogueItem, { itemId: item.id });
    await call(db, ctx, updateCatalogueItem, { itemId: item.id, categoryId: null });
    assert.deepEqual(await call(db, ctx, deleteCategory, { categoryId: grand.id }), { deleted: true });
    await call(db, ctx, deleteCategory, { categoryId: child.id });
    await call(db, ctx, deleteCategory, { categoryId: root.id });
    assert.equal((await call(db, ctx, listCategories, {})).length, 0);
    await rejectsWith(call(db, ctx, deleteCategory, { categoryId: root.id }), "NOT_FOUND");
  });
});

describe("getCatalogueForChannel (AI-safe)", () => {
  test("exposes only the AI-safe fields and never archived items, inactive categories or inactive variants", async () => {
    const t = await db.createTenant("cat-ai");
    const ctx = makeCtx(t);
    const hair = await call(db, ctx, createCategory, { name: "Hair" });
    const hidden = await call(db, ctx, createCategory, { name: "Staff only", active: false });
    const cut = await call(db, ctx, createCatalogueItem, service({
      name: "Haircut", description: "x".repeat(1500), sku: "INTERNAL-SKU-77", taxRateBps: 1800, bufferMinutes: 15, requiredResourceType: "staff",
      attributes: { costPrice: 12345, supplier: "ACME" }, categoryId: hair.id, sortOrder: 9,
    }) as never);
    await call(db, ctx, createVariant, { itemId: cut.id, name: "Long", amountPaise: 90000, durationMinutes: 60, sku: "VAR-SKU-9" });
    const oldVar = await call(db, ctx, createVariant, { itemId: cut.id, name: "Retired", amountPaise: 1 });
    await call(db, ctx, updateVariant, { variantId: oldVar.id, active: false });
    const gone = await call(db, ctx, createCatalogueItem, service({ name: "Archived thing" }) as never);
    await call(db, ctx, archiveCatalogueItem, { itemId: gone.id });
    await call(db, ctx, createCatalogueItem, service({ name: "In hidden category", categoryId: hidden.id }) as never);
    await call(db, ctx, createCatalogueItem, product({ name: "Off for now", available: false }) as never);

    const r = await call(db, ctx, getCatalogueForChannel, {});
    assert.deepEqual(r.items.map((i) => i.name), ["Off for now", "Haircut"]);
    const item = r.items[1]!;
    assert.deepEqual(Object.keys(item).sort(), ["amountPaise", "available", "catalogueItemId", "category", "currency", "description", "durationMinutes", "kind", "name", "variants"]);
    assert.equal(item.catalogueItemId, cut.id);
    assert.equal(item.amountPaise, 50000);
    assert.equal(item.category, "Hair");
    assert.equal(item.description?.length, 1000);
    assert.deepEqual(item.variants, [{ variantId: item.variants![0]!.variantId, name: "Long", amountPaise: 90000, durationMinutes: 60 }]);
    assert.equal(r.items[0]!.available, false, "unavailable items are listed, flagged");

    const wire = JSON.stringify(r);
    for (const secret of ["INTERNAL-SKU-77", "VAR-SKU-9", "costPrice", "ACME", "taxRateBps", "bufferMinutes", "requiredResourceType", "sortOrder", "archivedAt", "tenant", "Retired", "Archived thing", "In hidden category", "createdAt"]) {
      assert.ok(!wire.includes(secret), `AI catalogue must not contain "${secret}"`);
    }
  });

  test("filters by kind, exact category name (case-insensitive) and search word; pages; limit capped at 50", async () => {
    const t = await db.createTenant("cat-ai-filter");
    const ctx = makeCtx(t);
    const hair = await call(db, ctx, createCategory, { name: "Hair" });
    for (let i = 0; i < 5; i++) await call(db, ctx, createCatalogueItem, service({ name: `Cut ${i}`, categoryId: hair.id }) as never);
    await call(db, ctx, createCatalogueItem, product({ name: "Gel" }) as never);
    const names = async (q: Record<string, unknown>) => (await call(db, ctx, getCatalogueForChannel, q as never)).items.map((i) => i.name);
    assert.equal((await names({ kind: "product" })).join(), "Gel");
    assert.equal((await names({ category: "hair" })).length, 5);
    assert.equal((await names({ category: "Hai" })).length, 0, "category is an exact match");
    assert.deepEqual(await names({ query: "cut 3" }), ["Cut 3"]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await call(db, ctx, getCatalogueForChannel, { limit: 2, ...(cursor ? { cursor } : {}) });
      assert.ok(p.items.length <= 2);
      seen.push(...p.items.map((i) => i.name));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.length, 6);
    assert.equal(new Set(seen).size, 6);
    await rejectsWith(call(db, ctx, getCatalogueForChannel, { limit: 51 }), "VALIDATION_FAILED");
  });
});

describe("tenant isolation", () => {
  test("tenant A cannot read, change, list or link to tenant B's catalogue", async () => {
    const ta = await db.createTenant("cat-iso-a");
    const tb = await db.createTenant("cat-iso-b");
    const ctxA = makeCtx(ta);
    const ctxB = makeCtx(tb);
    const catB = await call(db, ctxB, createCategory, { name: "B cat" });
    const itemB = await call(db, ctxB, createCatalogueItem, service({ name: "B only service", sku: "B-1", categoryId: catB.id }) as never);
    const varB = await call(db, ctxB, createVariant, { itemId: itemB.id, name: "B var", amountPaise: 5 });
    const itemA = await call(db, ctxA, createCatalogueItem, service({ name: "A service", sku: "B-1" }) as never); // same SKU in another tenant is fine

    for (const fn of [getCatalogueItem, archiveCatalogueItem, restoreCatalogueItem]) await rejectsWith(call(db, ctxA, fn, { itemId: itemB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, updateCatalogueItem, { itemId: itemB.id, name: "hijack" }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, updateVariant, { variantId: varB.id, name: "hijack" }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, createVariant, { itemId: itemB.id, name: "planted", amountPaise: 1 }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, listVariants, { itemId: itemB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, updateCategory, { categoryId: catB.id, name: "hijack" }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, deleteCategory, { categoryId: catB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, createCategory, { name: "child of B", parentId: catB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, createCatalogueItem, service({ categoryId: catB.id }) as never), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, updateCatalogueItem, { itemId: itemA.id, categoryId: catB.id }), "NOT_FOUND");

    assert.deepEqual((await call(db, ctxA, listCatalogueItems, { archived: "include" })).items.map((i) => i.name), ["A service"]);
    assert.deepEqual((await call(db, ctxA, getCatalogueForChannel, {})).items.map((i) => i.name), ["A service"]);
    assert.deepEqual(await call(db, ctxA, listCategories, {}), []);

    const b = await call(db, ctxB, getCatalogueItem, { itemId: itemB.id });
    assert.equal(b.name, "B only service");
    assert.equal(b.archivedAt, null);
    assert.equal(b.variants[0]?.name, "B var");
    assert.equal((await call(db, ctxB, listCategories, {})).length, 1);
  });

  test("a client scoped to another tenant sees nothing through this tenant's context", async () => {
    const ta = await db.createTenant("cat-mm-a");
    const tb = await db.createTenant("cat-mm-b");
    const itemB = await call(db, makeCtx(tb), createCatalogueItem, service() as never);
    await assert.rejects(tx(db, ta, (c) => getCatalogueItem(c, makeCtx(tb), { itemId: itemB.id })), (e: { code?: string }) => e.code === "NOT_FOUND");
    const list = await tx(db, ta, (c) => listCatalogueItems(c, makeCtx(tb), {}));
    assert.equal(list.items.length, 0);
  });
});
