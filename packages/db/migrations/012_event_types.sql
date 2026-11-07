-- 012: webhook / outbox event vocabulary grows from 12 to 15 events.
-- Adds booking.expired, order.rejected and payment.refunded (WebhookEvent in @qenbel/shared).
-- The two CHECK constraints are replaced, not edited: existing rows all use values that stay allowed.

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_type_check CHECK (type IN (
  'booking.created', 'booking.confirmed', 'booking.rescheduled', 'booking.cancelled', 'booking.no_show',
  'booking.completed', 'booking.expired',
  'order.created', 'order.accepted', 'order.fulfilled', 'order.cancelled', 'order.rejected',
  'customer.created', 'payment.completed', 'payment.refunded'));

ALTER TABLE webhook_endpoints DROP CONSTRAINT webhook_endpoints_events_check;
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_events_check CHECK (
  cardinality(events) > 0 AND events <@ ARRAY[
    'booking.created', 'booking.confirmed', 'booking.rescheduled', 'booking.cancelled', 'booking.no_show',
    'booking.completed', 'booking.expired',
    'order.created', 'order.accepted', 'order.fulfilled', 'order.cancelled', 'order.rejected',
    'customer.created', 'payment.completed', 'payment.refunded']::text[]);
