-- 003: locations, users (a user row is one person's membership of one tenant), user_locations,
-- api_credentials, tenant_tool_settings.
-- Convention: every tenant table has UNIQUE (tenant_id, id) so children use composite foreign keys
-- (tenant_id, parent_id). A row can then never reference another tenant's row, even without RLS.

CREATE TABLE locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  address      jsonb NOT NULL DEFAULT '{}'::jsonb,
  phone        text,
  email        text,
  timezone     text NOT NULL DEFAULT 'Asia/Kolkata',   -- IANA name; availability is computed in this zone
  is_default   boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX locations_one_default ON locations (tenant_id) WHERE is_default;

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  auth_provider     text NOT NULL CHECK (auth_provider IN ('dev', 'clerk')),
  external_subject  text NOT NULL,                      -- Clerk "sub" or dev identity
  email             text,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  phone             text,
  role              text NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'STAFF')),
  disabled_at       timestamptz,
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, auth_provider, external_subject)
);
CREATE UNIQUE INDEX users_tenant_email ON users (tenant_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX users_subject_lookup ON users (auth_provider, external_subject);

-- Which locations a user may work at. No rows for a user = all locations (decided by the API).
CREATE TABLE user_locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  user_id      uuid NOT NULL,
  location_id  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id, location_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id) ON DELETE CASCADE
);

-- API keys for external agents and public widget keys. Only a peppered hash of an API key secret is
-- stored (HMAC-SHA256 with API_KEY_PEPPER; pepper_version supports rotation). The secret is shown once.
-- lookup_id is the non-secret public part (key prefix, or the widget key itself). It is globally unique
-- because it is how a request finds its tenant (via auth_lookup_credential, before any tenant context).
CREATE TABLE api_credentials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  credential_type     text NOT NULL CHECK (credential_type IN ('api_key', 'widget_key')),
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  lookup_id           text NOT NULL UNIQUE CHECK (char_length(lookup_id) BETWEEN 8 AND 128),
  secret_hash         text,
  pepper_version      smallint NOT NULL DEFAULT 1,
  tool_scopes         text[] NOT NULL DEFAULT '{}'::text[] CHECK (tool_scopes <@ ARRAY[
    'get_business_profile', 'search_customer', 'get_catalogue', 'check_availability',
    'create_booking_hold', 'confirm_booking', 'reschedule_booking', 'cancel_booking',
    'get_order_status', 'create_order_draft', 'confirm_order', 'cancel_order', 'escalate_to_human']::text[]),
  allowed_origins     text[] NOT NULL DEFAULT '{}'::text[],   -- widget keys: browser origins allowed to use it
  created_by_user_id  uuid,
  expires_at          timestamptz,
  revoked_at          timestamptz,
  last_used_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((credential_type = 'api_key') = (secret_hash IS NOT NULL)),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX api_credentials_tenant ON api_credentials (tenant_id);

-- Per-tenant switch for each tool (usable only if pack allows, tenant enabled, credential scoped).
CREATE TABLE tenant_tool_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  tool_name   text NOT NULL REFERENCES tool_definitions (name),
  enabled     boolean NOT NULL DEFAULT false,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, tool_name)
);
