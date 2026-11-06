-- 002: platform tables (no tenant_id): tenants, platform_admins, tool_definitions, config_pack_versions.

CREATE TABLE tenants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- central = shared multi-tenant cloud; isolated = one dedicated tenant in its own database
  deployment_mode   text NOT NULL DEFAULT 'central' CHECK (deployment_mode IN ('central', 'isolated')),
  pack_id           text,
  pack_version      text CHECK (pack_version IS NULL OR pack_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),   -- semver
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  default_timezone  text NOT NULL DEFAULT 'Asia/Kolkata',
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((pack_id IS NULL) = (pack_version IS NULL))
);
-- An isolated deployment holds exactly one tenant row.
CREATE UNIQUE INDEX tenants_single_isolated ON tenants ((true)) WHERE deployment_mode = 'isolated';

CREATE TABLE platform_admins (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_provider     text NOT NULL CHECK (auth_provider IN ('dev', 'clerk')),
  external_subject  text NOT NULL,
  email             text,
  name              text,
  disabled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auth_provider, external_subject)
);

CREATE TABLE tool_definitions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL UNIQUE CHECK (name IN (
    'get_business_profile', 'search_customer', 'get_catalogue', 'check_availability',
    'create_booking_hold', 'confirm_booking', 'reschedule_booking', 'cancel_booking',
    'get_order_status', 'create_order_draft', 'confirm_order', 'cancel_order', 'escalate_to_human')),
  permission_level         text NOT NULL CHECK (permission_level IN ('READ', 'WRITE', 'CONTROLLED_WRITE')),
  requires_idempotency_key boolean NOT NULL,
  description              text NOT NULL,
  -- platform-wide kill switch; a tenant can only disable further via tenant_tool_settings
  enabled                  boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (permission_level = 'READ' OR requires_idempotency_key)
);

-- Reference data mirrored from docs/ARCHITECTURE.md section 6. @qenbel/tool-registry owns the schemas.
INSERT INTO tool_definitions (name, permission_level, requires_idempotency_key, description) VALUES
  ('get_business_profile',  'READ',             false, 'Business name, hours, locations and policies.'),
  ('search_customer',       'READ',             false, 'Find a customer by phone, email or name. Minimal fields.'),
  ('get_catalogue',         'READ',             false, 'List services or items with prices and durations.'),
  ('check_availability',    'READ',             false, 'Open slots or tables for a service, party size and date range.'),
  ('create_booking_hold',   'WRITE',            true,  'Hold a slot for a short time. Idempotent.'),
  ('confirm_booking',       'CONTROLLED_WRITE', true,  'Confirm a live hold once required customer fields are present.'),
  ('reschedule_booking',    'CONTROLLED_WRITE', true,  'Move a confirmed booking.'),
  ('cancel_booking',        'CONTROLLED_WRITE', true,  'Cancel a booking under the cancellation policy.'),
  ('get_order_status',      'READ',             false, 'Status of an order.'),
  ('create_order_draft',    'WRITE',            true,  'Create a draft order. Idempotent.'),
  ('confirm_order',         'CONTROLLED_WRITE', true,  'Place a draft order.'),
  ('cancel_order',          'CONTROLLED_WRITE', true,  'Cancel an order that has not been fulfilled.'),
  ('escalate_to_human',     'WRITE',            true,  'Create a follow-up task and flag the conversation for staff.');

CREATE TABLE config_pack_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id       text NOT NULL,
  version       text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),   -- semver
  status        text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'withdrawn')),
  definition    jsonb NOT NULL,
  checksum      text,
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, version)
);

CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER platform_admins_set_updated_at BEFORE UPDATE ON platform_admins FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tool_definitions_set_updated_at BEFORE UPDATE ON tool_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER config_pack_versions_set_updated_at BEFORE UPDATE ON config_pack_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
