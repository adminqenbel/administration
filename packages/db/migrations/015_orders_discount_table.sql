-- 015: how an order's discount was made, the dine-in table, and the per-line tax rate snapshot.
-- (docs/CONTRACT-REQUESTS.md, engine-orders 2026-11-07.)
--
-- orders.discount_paise stays the amount actually taken off (totals still satisfy orders_total_consistent).
-- The new columns record HOW it was made, so a draft can recompute it after a line change instead of clearing it:
--   discount_type          'fixed' (discount_value = paise) or 'percent_bps' (discount_value = basis points of the subtotal)
--   discount_value         bigint, >= 0; at most 10000 for percent_bps. NULL together with discount_type.
--   discount_reason        why (plain text, <= 500 characters)
--   discount_cap_override  true when a principal with the override permission approved a discount above the cap
-- orders.resource_id is the table (a resources row of type 'table') of a dine-in order; the fulfilment row keeps
-- the label and any address. order_items.tax_rate_bps freezes the rate used for the line at order time.

ALTER TABLE orders
  ADD COLUMN discount_type text,
  ADD COLUMN discount_value bigint,
  ADD COLUMN discount_reason text,
  ADD COLUMN discount_cap_override boolean NOT NULL DEFAULT false,
  ADD COLUMN resource_id uuid;

ALTER TABLE orders
  ADD CONSTRAINT orders_discount_type_check CHECK (discount_type IS NULL OR discount_type IN ('fixed', 'percent_bps')),
  ADD CONSTRAINT orders_discount_value_check CHECK (discount_value IS NULL OR discount_value >= 0),
  ADD CONSTRAINT orders_discount_pair CHECK ((discount_type IS NULL) = (discount_value IS NULL)),
  ADD CONSTRAINT orders_discount_percent_bound CHECK (discount_type IS DISTINCT FROM 'percent_bps' OR discount_value <= 10000),
  ADD CONSTRAINT orders_discount_reason_check CHECK (discount_reason IS NULL OR char_length(discount_reason) <= 500),
  ADD CONSTRAINT orders_resource_fk FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id);
CREATE INDEX orders_resource ON orders (tenant_id, resource_id) WHERE resource_id IS NOT NULL;

ALTER TABLE order_items
  ADD COLUMN tax_rate_bps integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT order_items_tax_rate_bps_check CHECK (tax_rate_bps BETWEEN 0 AND 10000);

-- Backfill existing rows. The owner role is subject to FORCE RLS, so the tables involved are NO FORCE for the
-- duration of this transaction only (the runtime role stays filtered) and forced again straight after.
ALTER TABLE orders NO FORCE ROW LEVEL SECURITY;
ALTER TABLE order_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE fulfilments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE resources NO FORCE ROW LEVEL SECURITY;
ALTER TABLE catalogue_items NO FORCE ROW LEVEL SECURITY;

-- An existing discount has no recorded method: treat it as a fixed amount of exactly what was taken off.
UPDATE orders SET discount_type = 'fixed', discount_value = discount_paise
 WHERE discount_paise > 0 AND discount_type IS NULL;

-- Dine-in table that used to live in fulfilments.address ->> 'resourceId' (only when it is a real resource of the same tenant).
UPDATE orders o SET resource_id = r.id
  FROM fulfilments f, resources r
 WHERE f.tenant_id = o.tenant_id AND f.order_id = o.id AND f.type = 'dine_in'
   AND (f.address ->> 'resourceId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   AND r.tenant_id = o.tenant_id AND r.id = (f.address ->> 'resourceId')::uuid
   AND o.resource_id IS NULL;

-- Tax rate of existing lines: the catalogue rate today (the best information there is). Lines without a catalogue
-- item keep 0.
UPDATE order_items oi SET tax_rate_bps = ci.tax_rate_bps
  FROM catalogue_items ci
 WHERE ci.tenant_id = oi.tenant_id AND ci.id = oi.catalogue_item_id AND ci.tax_rate_bps <> oi.tax_rate_bps;

ALTER TABLE orders FORCE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
ALTER TABLE fulfilments FORCE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
ALTER TABLE catalogue_items FORCE ROW LEVEL SECURITY;
