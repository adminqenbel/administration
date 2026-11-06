-- 010: idempotency_keys, audit_log, outbox_events, webhook_endpoints, webhook_deliveries.

-- Idempotency: one row per (tenant, key, route). The first request inserts an in_progress row and, when it
-- finishes, stores the response; replays within 24 h return the stored response. A different request body
-- under the same key is detected by request_hash (the API answers 422).
CREATE TABLE idempotency_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  key              text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 255),
  route            text NOT NULL CHECK (char_length(route) BETWEEN 1 AND 255),   -- "POST /v1/bookings" or "tool:create_booking_hold"
  request_hash     text NOT NULL,                                              -- sha256 of the canonical request
  status           text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_status  integer CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  response_body    jsonb,
  locked_at        timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT idempotency_keys_unique_key UNIQUE (tenant_id, key, route)
);
CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);

-- Append-only audit trail. The app role has INSERT and SELECT only; a trigger rejects UPDATE and DELETE
-- for every role (owner included). Deliberately no updated_at column. details must never hold secrets.
CREATE TABLE audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          bigint GENERATED ALWAYS AS IDENTITY,        -- total order within the database
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  actor_kind   text NOT NULL CHECK (actor_kind IN ('user', 'api_credential', 'system', 'platform_admin')),
  actor_id     text,                                       -- user id, credential id, job name
  action       text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),   -- for example booking.confirm
  entity_type  text,
  entity_id    text,
  outcome      text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'denied', 'error')),
  channel      text CHECK (channel IS NULL OR channel IN ('web_chat', 'whatsapp', 'voice', 'api', 'dashboard')),
  request_id   text,
  ip_address   text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX audit_log_time ON audit_log (tenant_id, created_at DESC);
CREATE INDEX audit_log_entity ON audit_log (tenant_id, entity_type, entity_id);
CREATE UNIQUE INDEX audit_log_seq ON audit_log (seq);

CREATE FUNCTION audit_log_reject_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();

-- Transactional outbox: written in the same transaction as the business change, drained by a dispatcher.
CREATE TABLE outbox_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  event_id         uuid NOT NULL DEFAULT gen_random_uuid(),   -- sent to subscribers as eventId; the dedupe key
  type             text NOT NULL CHECK (type IN (
    'booking.created', 'booking.confirmed', 'booking.rescheduled', 'booking.cancelled', 'booking.no_show',
    'booking.completed', 'order.created', 'order.accepted', 'order.fulfilled', 'order.cancelled',
    'customer.created', 'payment.completed')),
  aggregate_type   text,
  aggregate_id     uuid,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_error       text CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  processed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (event_id)
);
CREATE INDEX outbox_events_due ON outbox_events (tenant_id, next_attempt_at) WHERE status IN ('pending', 'failed');

CREATE TABLE webhook_endpoints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  url               text NOT NULL CHECK (url ~ '^https?://' AND char_length(url) <= 2000),
  description       text CHECK (description IS NULL OR char_length(description) <= 500),
  -- HMAC-SHA256 signing secret, encrypted by the app with WEBHOOK_SIGNING_MASTER_KEY. Never stored in clear.
  secret_ciphertext text NOT NULL,
  events            text[] NOT NULL CHECK (cardinality(events) > 0 AND events <@ ARRAY[
    'booking.created', 'booking.confirmed', 'booking.rescheduled', 'booking.cancelled', 'booking.no_show',
    'booking.completed', 'order.created', 'order.accepted', 'order.fulfilled', 'order.cancelled',
    'customer.created', 'payment.completed']::text[]),
  enabled           boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  disabled_reason   text,
  created_by_user_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, id)
);

CREATE TABLE webhook_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  endpoint_id       uuid NOT NULL,
  event_id          uuid NOT NULL,                              -- outbox_events.event_id
  event_type        text NOT NULL,
  attempt           integer NOT NULL CHECK (attempt > 0),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  response_status   integer CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  response_excerpt  text CHECK (response_excerpt IS NULL OR char_length(response_excerpt) <= 1000),
  error             text CHECK (error IS NULL OR char_length(error) <= 2000),
  duration_ms       integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  next_attempt_at   timestamptz,
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, endpoint_id, event_id, attempt),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES webhook_endpoints (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (tenant_id, endpoint_id, created_at DESC);
