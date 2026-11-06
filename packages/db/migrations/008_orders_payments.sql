-- 008: orders, order_items, payments (ledger), fulfilments. Orders and bookings are separate records;
-- an order may optionally point at a booking (for example a dine-in order for a table booking).
-- Money is integer paise (bigint). No floats.

CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  reference         text NOT NULL DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  location_id       uuid,
  customer_id       uuid,
  booking_id        uuid,
  conversation_id   uuid,
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'PLACED', 'ACCEPTED', 'PROCESSING', 'READY', 'FULFILLED', 'CANCELLED', 'REJECTED', 'REFUNDED')),
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),   -- optimistic concurrency
  source_channel    text NOT NULL CHECK (source_channel IN ('web_chat', 'whatsapp', 'voice', 'api', 'dashboard')),
  payment_status    text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partial', 'paid', 'refunded')),
  subtotal_paise    bigint NOT NULL DEFAULT 0 CHECK (subtotal_paise >= 0),
  tax_paise         bigint NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  discount_paise    bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  total_paise       bigint NOT NULL DEFAULT 0 CHECK (total_paise >= 0),
  currency          char(3) NOT NULL DEFAULT 'INR',
  notes             text CHECK (notes IS NULL OR char_length(notes) <= 4000),   -- plain text
  placed_at         timestamptz,
  fulfilled_at      timestamptz,
  cancelled_at      timestamptz,
  cancellation_reason text CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) <= 2000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reference),
  CONSTRAINT orders_total_consistent CHECK (total_paise = subtotal_paise + tax_paise - discount_paise),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);
CREATE INDEX orders_status ON orders (tenant_id, status, created_at DESC);
CREATE INDEX orders_customer ON orders (tenant_id, customer_id, created_at DESC);
CREATE INDEX orders_booking ON orders (tenant_id, booking_id) WHERE booking_id IS NOT NULL;

CREATE TABLE order_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  order_id           uuid NOT NULL,
  catalogue_item_id  uuid,
  variant_id         uuid,
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),   -- snapshot at order time
  quantity           integer NOT NULL CHECK (quantity > 0),
  unit_price_paise   bigint NOT NULL CHECK (unit_price_paise >= 0),               -- snapshot at order time
  tax_paise          bigint NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  line_total_paise   bigint NOT NULL CHECK (line_total_paise >= 0),
  notes              text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT order_items_line_consistent CHECK (line_total_paise = quantity::bigint * unit_price_paise),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, catalogue_item_id) REFERENCES catalogue_items (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES catalogue_variants (tenant_id, id)
);
CREATE INDEX order_items_order ON order_items (tenant_id, order_id);

-- Payment ledger. Append-only in spirit: the app role may insert, read, and update only status and
-- provider_reference (a pending entry settling). Corrections are new rows (a refund is kind = 'refund').
-- No gateway integration yet: this records cash, card-machine, UPI-transfer and similar entries.
CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  order_id            uuid,
  booking_id          uuid,                       -- deposits are paid against a booking
  customer_id         uuid,
  kind                text NOT NULL CHECK (kind IN ('payment', 'refund')),
  method              text NOT NULL CHECK (method IN ('cash', 'card', 'upi', 'bank_transfer', 'online', 'other')),
  status              text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
  currency            char(3) NOT NULL DEFAULT 'INR',
  provider            text,
  provider_reference  text,
  note                text CHECK (note IS NULL OR char_length(note) <= 1000),
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (order_id IS NOT NULL OR booking_id IS NOT NULL),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE UNIQUE INDEX payments_provider_ref ON payments (tenant_id, provider, provider_reference)
  WHERE provider IS NOT NULL AND provider_reference IS NOT NULL;
CREATE INDEX payments_order ON payments (tenant_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX payments_booking ON payments (tenant_id, booking_id) WHERE booking_id IS NOT NULL;

CREATE TABLE fulfilments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  order_id       uuid NOT NULL,
  type           text NOT NULL CHECK (type IN ('pickup', 'delivery', 'dine_in', 'on_site')),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'scheduled', 'in_progress', 'completed', 'failed', 'cancelled')),
  address        jsonb,
  scheduled_for  timestamptz,
  completed_at   timestamptz,
  notes          text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX fulfilments_order ON fulfilments (tenant_id, order_id);
