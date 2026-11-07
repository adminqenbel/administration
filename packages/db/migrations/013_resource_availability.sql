-- 013: resource time off, daily breaks and resource-to-service eligibility as real tables.
--
-- Until now the engines kept these in resources.attributes under the reserved keys `timeOff`, `breaks` and
-- `serviceIds` (engine-catalog src/resources.ts, engine-bookings src/sql-source.ts). This migration creates the
-- tables, moves existing values into them and removes the keys. The move is a function so it can be re-run
-- (idempotent) if an engine that still uses the interim storage wrote more before it was switched over:
--     select app_move_resource_extras();        -- as qenbel_migrate; returns counts as jsonb

-- A blocked interval for one resource (leave, maintenance). Half-open [starts_at, ends_at), like allocations.
CREATE TABLE resource_time_off (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  resource_id         uuid NOT NULL,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  reason              text CHECK (reason IS NULL OR char_length(reason) <= 500),
  created_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT resource_time_off_unique UNIQUE (tenant_id, resource_id, starts_at, ends_at),
  CONSTRAINT resource_time_off_order CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, id)
);
-- overlap lookups: WHERE resource_id = $1 AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')
-- (or simply starts_at < $3 AND ends_at > $2). A generated range column is avoided on purpose: a reversed interval
-- would then fail with 22000 instead of the resource_time_off_order CHECK (23514).
CREATE INDEX resource_time_off_period ON resource_time_off USING gist (resource_id, tstzrange(starts_at, ends_at, '[)'));

-- A recurring weekly break inside a resource's working day, in the location's timezone (like resource_schedules).
-- weekday: 0 = Sunday ... 6 = Saturday. A break that applies every day has seven rows.
CREATE TABLE resource_breaks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  resource_id  uuid NOT NULL,
  weekday      smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time   time NOT NULL,
  end_time     time NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT resource_breaks_unique UNIQUE (tenant_id, resource_id, weekday, start_time, end_time),
  CONSTRAINT resource_breaks_order CHECK (end_time > start_time),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX resource_breaks_resource ON resource_breaks (tenant_id, resource_id, weekday);

-- Which services a resource can serve. A resource with no rows here can serve any service whose
-- required_resource_type matches its type (engine rule); rows narrow it to exactly those services.
CREATE TABLE resource_services (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  resource_id        uuid NOT NULL,
  catalogue_item_id  uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT resource_services_unique UNIQUE (tenant_id, resource_id, catalogue_item_id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, catalogue_item_id) REFERENCES catalogue_items (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX resource_services_item ON resource_services (tenant_id, catalogue_item_id);

SELECT app_secure_tenant_table('resource_time_off');
SELECT app_secure_tenant_table('resource_breaks');
SELECT app_secure_tenant_table('resource_services');

-- Plain editable lists: removing a row is a normal operation, so DELETE is granted.
GRANT SELECT, INSERT, UPDATE, DELETE ON resource_time_off, resource_breaks, resource_services TO qenbel_app;

-- Moves resources.attributes.{timeOff,breaks,serviceIds} into the tables above and removes the keys.
--   timeOff    [{ id?, startsAt|start, endsAt|end, reason? }]   -> resource_time_off (a uuid id is kept)
--   breaks     [{ start: "HH:MM", end: "HH:MM" }] (every day)    -> resource_breaks, one row per weekday 0..6
--   serviceIds [uuid, ...]                                       -> resource_services (ids of unknown or
--                                                                   other-tenant items are not linked)
-- Entries that cannot be converted (bad date, end before start, unknown service) are not lost: they are kept in
-- attributes.migrationSkipped.{timeOff,breaks,serviceIds} on that resource, and counted in the result.
-- The owner role is subject to FORCE RLS, so the tables involved are switched to NO FORCE for the duration of
-- this transaction (the runtime role stays filtered throughout) and forced again at the end.
-- Callable by the owner only (EXECUTE is revoked from PUBLIC and never granted to the runtime role).
CREATE FUNCTION app_move_resource_extras() RETURNS jsonb
  LANGUAGE plpgsql
  AS $$
DECLARE
  uuid_re  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  time_re  constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  r        record;
  e        jsonb;
  v_start  timestamptz;
  v_end    timestamptz;
  v_id     uuid;
  v_bs     time;
  v_be     time;
  v_item   uuid;
  linked   integer;
  skip_off jsonb;
  skip_brk jsonb;
  skip_svc jsonb;
  skipped  jsonb;
  attrs    jsonb;
  n_off    integer := 0;
  n_brk    integer := 0;
  n_svc    integer := 0;
  n_skip   integer := 0;
  n_res    integer := 0;
BEGIN
  ALTER TABLE resources NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE resource_time_off NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE resource_breaks NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE resource_services NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE catalogue_items NO FORCE ROW LEVEL SECURITY;

  FOR r IN
    SELECT id, tenant_id, attributes FROM resources
     WHERE attributes ?| ARRAY['timeOff', 'breaks', 'serviceIds']
     ORDER BY id
     FOR UPDATE
  LOOP
    n_res := n_res + 1;
    skip_off := '[]'::jsonb; skip_brk := '[]'::jsonb; skip_svc := '[]'::jsonb;

    IF jsonb_typeof(r.attributes -> 'timeOff') = 'array' THEN
      FOR e IN SELECT * FROM jsonb_array_elements(r.attributes -> 'timeOff') LOOP
        BEGIN
          v_start := coalesce(e ->> 'startsAt', e ->> 'start')::timestamptz;
          v_end   := coalesce(e ->> 'endsAt', e ->> 'end')::timestamptz;
          IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
            RAISE EXCEPTION 'bad interval';
          END IF;
          v_id := CASE WHEN e ->> 'id' ~ uuid_re THEN (e ->> 'id')::uuid ELSE gen_random_uuid() END;
          INSERT INTO resource_time_off (id, tenant_id, resource_id, starts_at, ends_at, reason)
          VALUES (v_id, r.tenant_id, r.id, v_start, v_end,
                  CASE WHEN jsonb_typeof(e -> 'reason') = 'string' THEN left(nullif(btrim(e ->> 'reason'), ''), 500) END)
          ON CONFLICT DO NOTHING;
          n_off := n_off + 1;
        EXCEPTION WHEN others THEN
          skip_off := skip_off || jsonb_build_array(e);
          n_skip := n_skip + 1;
        END;
      END LOOP;
    ELSIF r.attributes ? 'timeOff' THEN
      skip_off := jsonb_build_array(r.attributes -> 'timeOff');
      n_skip := n_skip + 1;
    END IF;

    IF jsonb_typeof(r.attributes -> 'breaks') = 'array' THEN
      FOR e IN SELECT * FROM jsonb_array_elements(r.attributes -> 'breaks') LOOP
        IF (e ->> 'start') ~ time_re AND (e ->> 'end') ~ time_re AND (e ->> 'end')::time > (e ->> 'start')::time THEN
          v_bs := (e ->> 'start')::time;
          v_be := (e ->> 'end')::time;
          INSERT INTO resource_breaks (tenant_id, resource_id, weekday, start_time, end_time)
          SELECT r.tenant_id, r.id, d, v_bs, v_be FROM generate_series(0, 6) AS d
          ON CONFLICT DO NOTHING;
          n_brk := n_brk + 1;
        ELSE
          skip_brk := skip_brk || jsonb_build_array(e);
          n_skip := n_skip + 1;
        END IF;
      END LOOP;
    ELSIF r.attributes ? 'breaks' THEN
      skip_brk := jsonb_build_array(r.attributes -> 'breaks');
      n_skip := n_skip + 1;
    END IF;

    IF jsonb_typeof(r.attributes -> 'serviceIds') = 'array' THEN
      FOR e IN SELECT * FROM jsonb_array_elements(r.attributes -> 'serviceIds') LOOP
        IF jsonb_typeof(e) = 'string' AND (e #>> '{}') ~ uuid_re THEN
          v_item := (e #>> '{}')::uuid;
          INSERT INTO resource_services (tenant_id, resource_id, catalogue_item_id)
          SELECT r.tenant_id, r.id, ci.id FROM catalogue_items ci WHERE ci.tenant_id = r.tenant_id AND ci.id = v_item
          ON CONFLICT DO NOTHING;
          -- linked now, or already linked: counted. Item missing for this tenant: kept in migrationSkipped.
          IF EXISTS (SELECT 1 FROM resource_services s
                      WHERE s.tenant_id = r.tenant_id AND s.resource_id = r.id AND s.catalogue_item_id = v_item) THEN
            n_svc := n_svc + 1;
          ELSE
            skip_svc := skip_svc || jsonb_build_array(e);
            n_skip := n_skip + 1;
          END IF;
        ELSE
          skip_svc := skip_svc || jsonb_build_array(e);
          n_skip := n_skip + 1;
        END IF;
      END LOOP;
    ELSIF r.attributes ? 'serviceIds' THEN
      skip_svc := jsonb_build_array(r.attributes -> 'serviceIds');
      n_skip := n_skip + 1;
    END IF;

    attrs := r.attributes - 'timeOff' - 'breaks' - 'serviceIds';
    skipped := '{}'::jsonb;
    IF jsonb_array_length(skip_off) > 0 THEN skipped := skipped || jsonb_build_object('timeOff', skip_off); END IF;
    IF jsonb_array_length(skip_brk) > 0 THEN skipped := skipped || jsonb_build_object('breaks', skip_brk); END IF;
    IF jsonb_array_length(skip_svc) > 0 THEN skipped := skipped || jsonb_build_object('serviceIds', skip_svc); END IF;
    IF skipped <> '{}'::jsonb THEN
      attrs := attrs || jsonb_build_object('migrationSkipped', skipped);
    END IF;
    UPDATE resources SET attributes = attrs WHERE id = r.id;
  END LOOP;

  ALTER TABLE resources FORCE ROW LEVEL SECURITY;
  ALTER TABLE resource_time_off FORCE ROW LEVEL SECURITY;
  ALTER TABLE resource_breaks FORCE ROW LEVEL SECURITY;
  ALTER TABLE resource_services FORCE ROW LEVEL SECURITY;
  ALTER TABLE catalogue_items FORCE ROW LEVEL SECURITY;

  IF n_skip > 0 THEN
    RAISE NOTICE 'app_move_resource_extras: % entries could not be converted; kept in resources.attributes.migrationSkipped', n_skip;
  END IF;
  RETURN jsonb_build_object('resources', n_res, 'timeOff', n_off, 'breakRules', n_brk, 'serviceLinks', n_svc, 'skipped', n_skip);
END $$;

REVOKE ALL ON FUNCTION app_move_resource_extras() FROM PUBLIC;

SELECT app_move_resource_extras();
