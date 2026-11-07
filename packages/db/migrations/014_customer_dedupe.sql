-- 014: customers are unique per tenant by phone and by e-mail among the active (not archived) ones.
--
-- Phone: customers.phone already carries the E.164 CHECK (004), so the stored value is the normalised one
-- and no new column is needed. E-mail is compared case-insensitively (lower(email)). Archived customers keep
-- their contact details and do not count, so a number can be reused once the old record is archived.
--
-- Existing duplicates (active rows sharing a phone, or sharing lower(email), within one tenant) are handled
-- before the indexes are built, without deleting or merging anything:
--   * the OLDEST active customer (created_at, then id) keeps the value;
--   * every other duplicate has that one field (phone or email) set to NULL;
--   * the removed value and the kept customer are recorded on the duplicate, in
--     attributes.dedupe.phone / attributes.dedupe.email = { "value": <old>, "keptCustomerId": <uuid>, "migration": "014" },
--     so staff can find and merge them by hand. Bookings, orders and payments keep pointing at the same rows.
-- A NOTICE reports how many values were cleared; nothing is touched when there are no duplicates.
-- The owner role is subject to FORCE RLS, so customers is NO FORCE for the duration of this transaction only.

ALTER TABLE customers NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  n_phone integer;
  n_email integer;
BEGIN
  WITH ranked AS (
    SELECT id, phone,
           first_value(id) OVER w AS kept_id,
           row_number() OVER w AS rn
      FROM customers
     WHERE archived_at IS NULL AND phone IS NOT NULL
    WINDOW w AS (PARTITION BY tenant_id, phone ORDER BY created_at, id)
  )
  UPDATE customers c
     SET phone = NULL,
         attributes = jsonb_set(c.attributes, '{dedupe}',
           coalesce(c.attributes -> 'dedupe', '{}'::jsonb)
           || jsonb_build_object('phone', jsonb_build_object('value', ranked.phone, 'keptCustomerId', ranked.kept_id, 'migration', '014')))
    FROM ranked
   WHERE c.id = ranked.id AND ranked.rn > 1;
  GET DIAGNOSTICS n_phone = ROW_COUNT;

  WITH ranked AS (
    SELECT id, email,
           first_value(id) OVER w AS kept_id,
           row_number() OVER w AS rn
      FROM customers
     WHERE archived_at IS NULL AND email IS NOT NULL
    WINDOW w AS (PARTITION BY tenant_id, lower(email) ORDER BY created_at, id)
  )
  UPDATE customers c
     SET email = NULL,
         attributes = jsonb_set(c.attributes, '{dedupe}',
           coalesce(c.attributes -> 'dedupe', '{}'::jsonb)
           || jsonb_build_object('email', jsonb_build_object('value', ranked.email, 'keptCustomerId', ranked.kept_id, 'migration', '014')))
    FROM ranked
   WHERE c.id = ranked.id AND ranked.rn > 1;
  GET DIAGNOSTICS n_email = ROW_COUNT;

  IF n_phone + n_email > 0 THEN
    RAISE NOTICE 'customer dedupe: cleared % duplicate phone(s) and % duplicate e-mail(s); see customers.attributes.dedupe', n_phone, n_email;
  END IF;
END $$;

ALTER TABLE customers FORCE ROW LEVEL SECURITY;

-- The race-proof guarantee: the engines still serialise with advisory locks and return the existing customer,
-- but two concurrent inserts can no longer both succeed. Violation: SQLSTATE 23505 on these constraint names.
CREATE UNIQUE INDEX customers_active_phone_unique ON customers (tenant_id, phone)
  WHERE archived_at IS NULL AND phone IS NOT NULL;
CREATE UNIQUE INDEX customers_active_email_unique ON customers (tenant_id, lower(email))
  WHERE archived_at IS NULL AND email IS NOT NULL;
