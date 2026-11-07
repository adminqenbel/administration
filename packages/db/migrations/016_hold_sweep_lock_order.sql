-- 016: one lock order for everything that expires or releases holds. Fixes a real deadlock (SQLSTATE 40P01).
--
-- The problem (reported by the booking engine, reproduced by test/hold-sweep-locks.test.ts):
--   * the allocation insert trigger released expired overlapping holds allocation-first, then updated their bookings;
--   * expire_booking_holds*() updated bookings first, and bookings_sync_allocations then updated the allocations.
-- Same rows, opposite orders. A sweep racing a new hold over still-unswept expired holds could deadlock; the
-- loser was aborted with 40P01 (the engine maps that to a retry, but it should not happen).
--
-- The canonical order, in the trigger and in both sweeps, is now:
--     resources (ascending id)  ->  bookings (ascending id)  ->  booking_allocations
-- which is also the order confirm/cancel already follow (UPDATE bookings, then the sync trigger updates allocations).
-- Locks on parent rows are FOR NO KEY UPDATE, so foreign-key checks from other transactions are not blocked.
--
-- Consequences for callers:
--   * insert allocations of one booking in ascending resource_id order (unchanged rule);
--   * a transaction that has already locked or updated a HOLD booking and then inserts an allocation on a resource
--     that another transaction holds can still wait on it, but cannot deadlock with the sweep or the trigger.

-- The cross-tenant sweep now locks the resources of the holds it is about to expire, like the insert trigger does.
-- qenbel_platform needs just enough privilege for SELECT ... FOR NO KEY UPDATE: SELECT plus UPDATE on one column.
GRANT SELECT, UPDATE (updated_at) ON resources TO qenbel_platform;

-- 1. Allocation guard: same logic as 007, with bookings locked before their allocations are touched.
CREATE OR REPLACE FUNCTION booking_allocations_guard() RETURNS trigger
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

  -- (1) the resource row: serialises every allocation attempt on this resource (see 007 for the why).
  SELECT allocation_mode, capacity_units INTO r_mode, r_cap
    FROM resources WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resource not found for this tenant' USING ERRCODE = '23503';
  END IF;
  NEW.exclusive := (r_mode = 'exclusive');

  -- An expired hold must not block a new booking just because the sweep job has not run yet.
  -- (2) lock the bookings of those holds first, in id order ...
  PERFORM 1 FROM bookings b
   WHERE b.tenant_id = NEW.tenant_id AND b.status = 'HOLD'
     AND b.id IN (SELECT a.booking_id FROM booking_allocations a
                   WHERE a.tenant_id = NEW.tenant_id AND a.resource_id = NEW.resource_id
                     AND a.active AND a.expires_at IS NOT NULL AND a.expires_at <= clock_timestamp()
                     AND a.period && NEW.period AND a.id <> NEW.id)
   ORDER BY b.id
   FOR NO KEY UPDATE;

  -- (3) ... then release their allocations, then mark the bookings expired.
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

-- 2. Sweep for the current tenant (SECURITY INVOKER, under RLS): resources -> bookings -> allocations.
CREATE OR REPLACE FUNCTION expire_booking_holds_for_current_tenant(p_now timestamptz DEFAULT clock_timestamp())
  RETURNS integer
  LANGUAGE plpgsql
  AS $$
DECLARE
  n integer;
BEGIN
  -- resources of every hold about to expire, ascending
  PERFORM 1 FROM resources r
   WHERE r.id IN (
     SELECT a.resource_id FROM booking_allocations a
      WHERE a.active AND a.expires_at IS NOT NULL AND a.expires_at <= p_now
     UNION
     SELECT a.resource_id FROM booking_allocations a JOIN bookings b ON b.tenant_id = a.tenant_id AND b.id = a.booking_id
      WHERE a.active AND b.status = 'HOLD' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at <= p_now)
   ORDER BY r.id
   FOR NO KEY UPDATE;

  -- their bookings, ascending
  PERFORM 1 FROM bookings b
   WHERE (b.status = 'HOLD' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at <= p_now)
      OR b.id IN (SELECT a.booking_id FROM booking_allocations a WHERE a.active AND a.expires_at IS NOT NULL AND a.expires_at <= p_now)
   ORDER BY b.id
   FOR NO KEY UPDATE;

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

-- 3. Cross-tenant sweep (SECURITY DEFINER, owned by qenbel_platform). CREATE OR REPLACE needs ownership, so
-- the migration role steps into qenbel_platform (it has SET on it, see infra/postgres/init) for this statement.
SET LOCAL ROLE qenbel_platform;

CREATE OR REPLACE FUNCTION expire_booking_holds(p_now timestamptz DEFAULT clock_timestamp())
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  n integer;
BEGIN
  PERFORM 1 FROM resources r
   WHERE r.id IN (
     SELECT a.resource_id FROM booking_allocations a
      WHERE a.active AND a.expires_at IS NOT NULL AND a.expires_at <= p_now
     UNION
     SELECT a.resource_id FROM booking_allocations a JOIN bookings b ON b.tenant_id = a.tenant_id AND b.id = a.booking_id
      WHERE a.active AND b.status = 'HOLD' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at <= p_now)
   ORDER BY r.id
   FOR NO KEY UPDATE;

  PERFORM 1 FROM bookings b
   WHERE (b.status = 'HOLD' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at <= p_now)
      OR b.id IN (SELECT a.booking_id FROM booking_allocations a WHERE a.active AND a.expires_at IS NOT NULL AND a.expires_at <= p_now)
   ORDER BY b.id
   FOR NO KEY UPDATE;

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

RESET ROLE;
