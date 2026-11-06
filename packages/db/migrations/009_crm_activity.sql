-- 009: follow_up_tasks, communications, notification_templates, notifications.

CREATE TABLE follow_up_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  customer_id       uuid,
  booking_id        uuid,
  order_id          uuid,
  conversation_id   uuid,
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  details           text CHECK (details IS NULL OR char_length(details) <= 4000),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  origin            text NOT NULL DEFAULT 'staff' CHECK (origin IN ('staff', 'ai_escalation', 'system')),
  due_at            timestamptz,
  assigned_user_id  uuid,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX follow_up_tasks_open ON follow_up_tasks (tenant_id, status, due_at);

-- Log of contact with a customer, in any direction, on any channel.
CREATE TABLE communications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  customer_id         uuid NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel             text NOT NULL CHECK (channel IN ('web_chat', 'whatsapp', 'voice', 'api', 'dashboard', 'email', 'sms')),
  subject             text CHECK (subject IS NULL OR char_length(subject) <= 300),
  body                text CHECK (body IS NULL OR char_length(body) <= 10000),   -- plain text
  conversation_id     uuid,
  booking_id          uuid,
  order_id            uuid,
  created_by_user_id  uuid,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX communications_customer ON communications (tenant_id, customer_id, occurred_at DESC);

CREATE TABLE notification_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{1,80}$'),   -- for example booking.confirmed
  channel     text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms', 'in_app')),
  locale      text NOT NULL DEFAULT 'en',
  subject     text CHECK (subject IS NULL OR char_length(subject) <= 300),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),   -- plain text with {{placeholders}}
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, key, channel, locale)
);

CREATE TABLE notifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  template_id           uuid,
  customer_id           uuid,
  booking_id            uuid,
  order_id              uuid,
  channel               text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms', 'in_app')),
  recipient             text NOT NULL CHECK (char_length(recipient) BETWEEN 1 AND 320),
  subject               text CHECK (subject IS NULL OR char_length(subject) <= 300),
  body                  text NOT NULL CHECK (char_length(body) <= 10000),
  status                text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts              integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  scheduled_for         timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz,
  provider_message_id   text,
  last_error            text CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES notification_templates (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id)
);
CREATE INDEX notifications_due ON notifications (tenant_id, scheduled_for) WHERE status = 'queued';
