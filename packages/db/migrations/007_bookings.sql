-- 007: bookings and booking_allocations. Double booking is prevented here, in the database.
--
-- bookings carry the business facts (who, what, when, status, policy snapshot, deposit).
-- booking_allocations carry "which resource is occupied during which period" and hold the constraints:
--   * exclusive resources: EXCLUDE USING gist (tenant_id =, resource_id =, period &&) WHERE (active AND exclusive)
--   * shared-capacity resources: a trigger serialises on the resource row and checks the peak concurrent
--     units never exceed resources.capacity_units.
-- Periods are half-open [start, end): a booking ending at 11:00 and one starting at 11:00 do not overlap.

CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  reference           text NOT NULL DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  location_id         uuid,
  customer_id         uuid,
  catalogue_item_id   uuid,
  variant_id          uuid,
  conversation_id     uuid,
  status              text NOT NULL DEFAULT 'HOLD' CHECK (status IN (
    'HOLD', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'NO_SHOW')),
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),   -- optimistic concurrency
  source_channel      text NOT NULL CHECK (source_channel IN ('web_chat', 'whatsapp', 'voice', 'api', 'dashboard')),
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  party_size          integer CHECK (party_size IS NULL OR party_size > 0),
  notes               text CHECK (notes IS NULL OR char_length(notes) <= 4000),   -- plain text from the customer
  hold_expires_at     timestamptz,
  confirmed_at        timestamptz,
  cancelled_at        timestamptz,
  cancellation_reason text CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) <= 2000),
  -- cancellation policy and pack terms as they were when the booking was made
  policy_snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,
  deposit_paise       bigint NOT NULL DEFAULT 0 CHECK (deposit_paise >= 0),
  deposit_status      text NOT NULL DEFAULT 'unpaid' CHECK (deposit_status IN ('unpaid', 'partial', 'paid', 'refunded')),
  currency            char(3) NOT NULL DEFAULT 'INR',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reference),
  CHECK (ends_at > starts_at),
  CHECK (status <> 'HOLD' OR hold_expires_at IS NOT NULL),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, catalogue_item_id) REFERENCES catalogue_items (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES catalogue_variants (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);
CREATE INDEX bookings_time ON bookings (tenant_id, starts_at);
CREATE INDEX bookings_status ON bookings (tenant_id, status, starts_at);
CREATE INDEX bookings_customer ON bookings (tenant_id, customer_id, starts_at DESC);
CREATE INDEX bookings_open_holds ON bookings (hold_expires_at) WHERE status = 'HOLD';

CREATE TABLE booking_allocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  booking_id   uuid NOT NULL,
  resource_id  uuid NOT NULL,
  period       tstzrange NOT NULL,
  -- units consumed. Matters only for shared-capacity resources. Exclusive resources ignore it.
  units        integer NOT NULL DEFAULT 1 CHECK (units > 0),
  -- Derived from resources.allocation_mode by trigger; clients cannot choose it.
  exclusive    boolean NOT NULL DEFAULT true,
  active       boolean NOT NULL DEFAULT true,
  -- Holds are allocations with expires_at. Confirmed bookings have NULL.
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT booking_allocations_period_valid CHECK (
    NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)
    AND lower_inc(period) AND NOT upper_inc(period)),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id),
  CONSTRAINT booking_allocations_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, resource_id WITH =, period WITH &&
  ) WHERE (active AND exclusive)
);
CREATE INDEX booking_allocations_booking ON booking_allocations (tenant_id, booking_id);
CREATE INDEX booking_allocations_resource_period ON booking_allocations USING gist (resource_id, period) WHERE active;
CREATE INDEX booking_allocations_expiring ON booking_allocations (expires_at) WHERE active AND expires_at IS NOT NULL;

-- Guard: derive `exclusive`, release expired holds that block the same slot, enforce shared capacity.
CREATE FUNCTION booking_allocations_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  r_mode  text;
  r_cap   integer;
  peak    integer;
BEGIN
  IF NOT NEW.active THEN
    RETURN NEW;                       -- releasing a slot never needs a check
  END IF;

  -- Serialise every allocation attempt on this resource (exclusive or shared) behind one row lock, taken
  -- before the constraint check. Without it, concurrent inserts for the same slot detect each other inside
  -- the exclusion index, wait on each other and deadlock; Postgres then aborts victims after deadlock_timeout
  -- and can abort every contender. With the lock, a loser waits briefly, then fails fast with 23P01.
  -- FOR NO KEY UPDATE does not block foreign-key checks from other tables. A booking that needs several
  -- resources must insert its allocations in resource_id order so lock order is consistent.
  SELECT allocation_mode, capacity_units INTO r_mode, r_cap
    FROM resources WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resource not found for this tenant' USING ERRCODE = '23503';
  END IF;
  NEW.exclusive := (r_mode = 'exclusive');

  -- An expired hold must not block a new booking just because the sweep job has not run yet.
  WITH released AS (
    UPDATE booking_allocations a
       SET active = false, updated_at = now()
     WHERE a.tenant_id = NEW.tenant_id AND a.resource_id = NEW.resource_id
       AND a.active AND a.expires_at IS NOT NULL AND a.expires_at <= clock_timestamp()
       AND a.period && NEW.period AND a.id <> NEW.id
    RETURNING a.booking_id
  )
  UPDATE bookings b SET status = 'EXPIRED', version = b.version + 1, updated_at = now()
   WHERE b.tenant_id = NEW.tenant_id AND b.status = 'HOLD'
     AND b.id IN (SELECT booking_id FROM released);

  IF NOT NEW.exclusive THEN
    -- Peak concurrent usage over the new period (the resource row is already locked above). Concurrency
    -- peaks at the start of some allocation, so test the new start and every overlapping allocation start
    -- inside the new period.
    SELECT coalesce(max(used), 0) INTO peak FROM (
      SELECT (SELECT coalesce(sum(a.units), 0)
                FROM booking_allocations a
               WHERE a.tenant_id = NEW.tenant_id AND a.resource_id = NEW.resource_id
                 AND a.active AND a.id <> NEW.id AND a.period @> p.t) AS used
        FROM (
          SELECT lower(NEW.period) AS t
          UNION
          SELECT lower(a.period)
            FROM booking_allocations a
           WHERE a.tenant_id = NEW.tenant_id AND a.resource_id = NEW.resource_id
             AND a.active AND a.id <> NEW.id AND a.period && NEW.period
             AND lower(a.period) > lower(NEW.period)
        ) p
    ) q;

    IF peak + NEW.units > r_cap THEN
      RAISE EXCEPTION 'resource capacity exceeded (% used + % requested > % available)', peak, NEW.units, r_cap
        USING ERRCODE = '23P01', CONSTRAINT = 'booking_allocations_capacity';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER booking_allocations_guard
  BEFORE INSERT OR UPDATE OF resource_id, period, units, active ON booking_allocations
  FOR EACH ROW EXECUTE FUNCTION booking_allocations_guard();

-- Changing a resource between exclusive and shared while it has active allocations would break the invariants.
CREATE FUNCTION resources_mode_change_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.allocation_mode IS DISTINCT FROM OLD.allocation_mode OR NEW.capacity_units < OLD.capacity_units)
     AND EXISTS (SELECT 1 FROM booking_allocations a
                  WHERE a.tenant_id = OLD.tenant_id AND a.resource_id = OLD.id AND a.active) THEN
    RAISE EXCEPTION 'cannot change allocation_mode or reduce capacity_units while the resource has active allocations'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER resources_mode_change_guard
  BEFORE UPDATE OF allocation_mode, capacity_units ON resources
  FOR EACH ROW EXECUTE FUNCTION resources_mode_change_guard();

-- Booking status drives allocation state: terminal-and-releasing statuses free the slot; CONFIRMED ends the hold.
CREATE FUNCTION bookings_sync_allocations() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('CANCELLED', 'EXPIRED', 'NO_SHOW') THEN
      UPDATE booking_allocations SET active = false, updated_at = now()
       WHERE tenant_id = NEW.tenant_id AND booking_id = NEW.id AND active;
    ELSIF NEW.status = 'CONFIRMED' THEN
      UPDATE booking_allocations SET expires_at = NULL, updated_at = now()
       WHERE tenant_id = NEW.tenant_id AND booking_id = NEW.id AND active AND expires_at IS NOT NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bookings_sync_allocations
  AFTER UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_sync_allocations();

-- Hold expiry for the current tenant (SECURITY INVOKER: runs under the caller's RLS context).
-- Returns the number of holds expired. Safe to call often; the API calls it before availability checks.
CREATE FUNCTION expire_booking_holds_for_current_tenant(p_now timestamptz DEFAULT clock_timestamp())
  RETURNS integer
  LANGUAGE plpgsql
  AS $$
DECLARE
  n integer;
BEGIN
  WITH expired AS (
    UPDATE bookings
       SET status = 'EXPIRED', version = version + 1, updated_at = now()
     WHERE status = 'HOLD' AND hold_expires_at IS NOT NULL AND hold_expires_at <= p_now
    RETURNING id
  )
  SELECT count(*) INTO n FROM expired;

  -- allocation-level expiry for holds whose booking row was not marked (defensive)
  UPDATE booking_allocations SET active = false, updated_at = now()
   WHERE active AND expires_at IS NOT NULL AND expires_at <= p_now;

  RETURN n;
END $$;

-- Cross-tenant sweep for the background job. SECURITY DEFINER, owned by qenbel_platform (see 011).
-- Does only this one thing; it takes no tenant argument and returns only a count.
CREATE FUNCTION expire_booking_holds(p_now timestamptz DEFAULT clock_timestamp())
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  n integer;
BEGIN
  WITH expired AS (
    UPDATE bookings
       SET status = 'EXPIRED', version = version + 1, updated_at = now()
     WHERE status = 'HOLD' AND hold_expires_at IS NOT NULL AND hold_expires_at <= p_now
    RETURNING id
  )
  SELECT count(*) INTO n FROM expired;

  UPDATE booking_allocations SET active = false, updated_at = now()
   WHERE active AND expires_at IS NOT NULL AND expires_at <= p_now;

  RETURN n;
END $$;
