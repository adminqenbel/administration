-- 005: catalogue (categories, items, variants), resources, schedules, business hours, holidays.

CREATE TABLE catalogue_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  parent_id   uuid,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES catalogue_categories (tenant_id, id)
);

CREATE TABLE catalogue_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  category_id             uuid,
  kind                    text NOT NULL CHECK (kind IN ('service', 'product')),
  name                    text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description             text CHECK (description IS NULL OR char_length(description) <= 4000),
  sku                     text,
  base_price_paise        bigint NOT NULL CHECK (base_price_paise >= 0),
  currency                char(3) NOT NULL DEFAULT 'INR',
  duration_minutes        integer CHECK (duration_minutes IS NULL OR duration_minutes > 0),   -- services
  buffer_minutes          integer NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  tax_rate_bps            integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  required_resource_type  text CHECK (required_resource_type IS NULL
                            OR required_resource_type IN ('staff', 'room', 'table', 'equipment', 'doctor', 'vehicle')),
  attributes              jsonb NOT NULL DEFAULT '{}'::jsonb,
  available               boolean NOT NULL DEFAULT true,
  sort_order              integer NOT NULL DEFAULT 0,
  archived_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES catalogue_categories (tenant_id, id)
);
CREATE INDEX catalogue_items_category ON catalogue_items (tenant_id, category_id);
CREATE UNIQUE INDEX catalogue_items_sku ON catalogue_items (tenant_id, sku) WHERE sku IS NOT NULL AND archived_at IS NULL;

CREATE TABLE catalogue_variants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  item_id           uuid NOT NULL,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  sku               text,
  price_paise       bigint NOT NULL CHECK (price_paise >= 0),       -- full price of this variant
  duration_minutes  integer CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  sort_order        integer NOT NULL DEFAULT 0,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, item_id, name),
  FOREIGN KEY (tenant_id, item_id) REFERENCES catalogue_items (tenant_id, id) ON DELETE CASCADE
);

-- Bookable things: staff, rooms, tables, equipment, doctors, vehicles.
-- See packages/db/README.md, "Capacity model", for allocation_mode and capacity_units.
CREATE TABLE resources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  location_id      uuid,
  user_id          uuid,                                     -- a staff or doctor resource may be a login user
  type             text NOT NULL CHECK (type IN ('staff', 'room', 'table', 'equipment', 'doctor', 'vehicle')),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- exclusive: one booking at a time (a stylist, a table, a room).
  -- shared: bookings may overlap while the sum of their units never exceeds capacity_units
  --         (group class, counter seating, a minibus).
  allocation_mode  text NOT NULL DEFAULT 'exclusive' CHECK (allocation_mode IN ('exclusive', 'shared')),
  -- exclusive table: seats at the table (a party must fit). shared: units available at any instant.
  capacity_units   integer NOT NULL DEFAULT 1 CHECK (capacity_units > 0),
  min_units        integer NOT NULL DEFAULT 1 CHECK (min_units > 0 AND min_units <= capacity_units),
  attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  active           boolean NOT NULL DEFAULT true,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX resources_location_type ON resources (tenant_id, location_id, type) WHERE archived_at IS NULL;

-- Weekly working pattern of a resource, in the location's timezone. Several rows per weekday are allowed
-- (split shifts). weekday: 0 = Sunday ... 6 = Saturday (same as EXTRACT(dow ...)).
CREATE TABLE resource_schedules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  resource_id  uuid NOT NULL,
  weekday      smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time   time NOT NULL,
  end_time     time NOT NULL,
  valid_from   date,
  valid_to     date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (end_time > start_time),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX resource_schedules_resource ON resource_schedules (tenant_id, resource_id, weekday);

CREATE TABLE business_hours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  location_id  uuid NOT NULL,
  weekday      smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  open_time    time NOT NULL,
  close_time   time NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (close_time > open_time),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX business_hours_location ON business_hours (tenant_id, location_id, weekday);

-- A date on which a location is closed (or open on special hours). location_id NULL = all locations.
CREATE TABLE holidays (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  location_id   uuid,
  holiday_date  date NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  closed        boolean NOT NULL DEFAULT true,
  open_time     time,
  close_time    time,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((closed AND open_time IS NULL AND close_time IS NULL)
      OR (NOT closed AND open_time IS NOT NULL AND close_time IS NOT NULL AND close_time > open_time)),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX holidays_unique_day
  ON holidays (tenant_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date);
