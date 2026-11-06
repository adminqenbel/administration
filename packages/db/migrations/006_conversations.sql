-- 006: conversations and messages for the AI agent runtime (website chat, WhatsApp, voice transcripts).
-- The AI never owns business state: these rows are a transcript plus counters, nothing more.

CREATE TABLE conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  channel             text NOT NULL CHECK (channel IN ('web_chat', 'whatsapp', 'voice', 'api', 'dashboard')),
  customer_id         uuid,
  api_credential_id   uuid,                         -- the widget key or API credential the conversation came in on
  external_ref        text,                         -- provider thread id, WhatsApp number hash, call id
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'escalated', 'closed')),
  escalated_at        timestamptz,
  escalation_reason   text CHECK (escalation_reason IS NULL OR char_length(escalation_reason) <= 2000),
  input_tokens        bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),    -- running totals, for daily caps
  output_tokens       bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  last_message_at     timestamptz,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, api_credential_id) REFERENCES api_credentials (tenant_id, id)
);
CREATE INDEX conversations_status ON conversations (tenant_id, status, last_message_at DESC);
CREATE INDEX conversations_customer ON conversations (tenant_id, customer_id);
CREATE UNIQUE INDEX conversations_external ON conversations (tenant_id, channel, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE conversation_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  conversation_id  uuid NOT NULL,
  seq              integer NOT NULL CHECK (seq >= 0),
  role             text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content          text CHECK (content IS NULL OR char_length(content) <= 20000),   -- plain text, escaped on output
  tool_name        text CHECK (tool_name IS NULL OR tool_name IN (
    'get_business_profile', 'search_customer', 'get_catalogue', 'check_availability',
    'create_booking_hold', 'confirm_booking', 'reschedule_booking', 'cancel_booking',
    'get_order_status', 'create_order_draft', 'confirm_order', 'cancel_order', 'escalate_to_human')),
  tool_call_id     text,
  tool_arguments   jsonb,                           -- untrusted model output, kept for audit only
  tool_result      jsonb,
  input_tokens     integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens    integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, conversation_id, seq),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
