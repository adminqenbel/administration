-- 004: customers (CRM core), tags, notes. Soft delete via archived_at.

CREATE TABLE customers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  phone                text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),   -- E.164
  email                text CHECK (email IS NULL OR char_length(email) <= 320),
  source               text CHECK (source IS NULL OR source IN ('web_chat', 'whatsapp', 'voice', 'api', 'dashboard')),
  attributes           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- pack-defined fields (for example allergies)
  consent_marketing    boolean NOT NULL DEFAULT false,
  consent_updated_at   timestamptz,
  archived_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX customers_phone ON customers (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX customers_email ON customers (tenant_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX customers_name ON customers (tenant_id, lower(name) text_pattern_ops);

CREATE TABLE customer_tags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  customer_id  uuid NOT NULL,
  tag          text NOT NULL CHECK (char_length(tag) BETWEEN 1 AND 60),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, customer_id, tag),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE customer_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  customer_id     uuid NOT NULL,
  author_user_id  uuid,
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),   -- plain text
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX customer_notes_customer ON customer_notes (tenant_id, customer_id, created_at DESC);
