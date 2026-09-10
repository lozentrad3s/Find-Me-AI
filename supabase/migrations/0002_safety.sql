-- ---------------------------------------------------------------------------
-- Safety: SOS alerts and community incident reports.
--
-- Apply this before SUPABASE_SERVICE_ROLE_KEY is set, or every safety write
-- fails. The app degrades to an in-memory store and says so on screen rather
-- than pretending, but an emergency alert that does not survive a serverless
-- instance recycling is not something to ship.
--
-- RLS is ON and there are NO public policies. Every access goes through a
-- route handler using the service role key, which bypasses RLS. That is
-- deliberate: the alert token is checked in the route, and exposing these
-- tables to anon would mean anyone with the URL could enumerate live
-- emergencies and the positions of the people in them.
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";

-- --- Alerts ----------------------------------------------------------------

create table if not exists public.sos_alerts (
  id                   uuid primary key default gen_random_uuid(),

  -- The tracking link IS the credential. 32 hex chars from the app.
  token                text        not null unique,

  kind                 text        not null default 'unspecified'
                         check (kind in ('unspecified','medical','crime',
                                         'accident','fire','lost','harassment')),
  status               text        not null default 'active'
                         check (status in ('active','resolved','expired')),
  note                 text,

  opened_at            timestamptz not null default now(),
  resolved_at          timestamptz,

  -- Denormalised latest position. A responder watches this; the trail is
  -- history. Kept as plain columns so the "alerts near me" query is a plain
  -- bounding-box filter and needs no PostGIS — this has to work on a default
  -- Supabase project.
  last_lat             double precision,
  last_lng             double precision,
  last_accuracy_m      double precision,
  last_heading         double precision,
  last_speed_mps       double precision,
  last_fix_at          timestamptz,

  location_description text,

  -- What was attempted and what actually happened, per channel.
  dispatch             jsonb       not null default '[]'::jsonb,
  -- Position history, oldest first, capped by the app at 1500 fixes.
  trail                jsonb       not null default '[]'::jsonb
);

-- The hot query: active alerts in a box, newest first.
create index if not exists sos_alerts_active_idx
  on public.sos_alerts (status, opened_at desc)
  where status = 'active';

create index if not exists sos_alerts_position_idx
  on public.sos_alerts (last_lat, last_lng)
  where status = 'active';

alter table public.sos_alerts enable row level security;

-- --- Incident reports ------------------------------------------------------

create table if not exists public.incident_reports (
  id            uuid        primary key default gen_random_uuid(),
  kind          text        not null default 'other'
                  check (kind in ('robbery','kidnapping','accident','fire',
                                  'flood','roadblock','unrest','suspicious','other')),
  lat           double precision not null,
  lng           double precision not null,
  area          text,
  note          text,
  at            timestamptz not null default now(),

  -- Maintained by confirm_incident(). Denormalised so the feed is one read.
  confirmations integer     not null default 0,

  -- Salted hash of IP + device id. Exists solely to stop a device confirming
  -- its own report or flooding duplicates. Never returned to a client.
  reporter_hash text        not null,

  from_alert_id uuid        references public.sos_alerts (id) on delete set null
);

create index if not exists incident_reports_recent_idx
  on public.incident_reports (at desc);

create index if not exists incident_reports_position_idx
  on public.incident_reports (lat, lng);

alter table public.incident_reports enable row level security;

-- --- Confirmations ---------------------------------------------------------
-- Separate table so "one per device" is a constraint the database enforces,
-- not a check the application hopes it won.

create table if not exists public.incident_confirmations (
  incident_id   uuid        not null references public.incident_reports (id)
                              on delete cascade,
  reporter_hash text        not null,
  at            timestamptz not null default now(),
  primary key (incident_id, reporter_hash)
);

alter table public.incident_confirmations enable row level security;

-- ---------------------------------------------------------------------------
-- confirm_incident — record a corroboration and return the updated report.
--
-- Both rules live in one transaction:
--   * you cannot confirm your own report
--   * you cannot confirm the same report twice
--
-- Doing this in TypeScript would let two taps a millisecond apart both pass a
-- read-then-write check, and "confirmations" is the only number separating a
-- rumour from a hazard people will route around.
-- ---------------------------------------------------------------------------

create or replace function public.confirm_incident(p_id uuid, p_hash text)
returns setof public.incident_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner text;
begin
  select reporter_hash into v_owner
    from public.incident_reports
   where id = p_id;

  if v_owner is null then
    return;                                  -- no such report
  end if;

  if v_owner is not distinct from p_hash then
    return query select * from public.incident_reports where id = p_id;
    return;                                  -- own report: return unchanged
  end if;

  insert into public.incident_confirmations (incident_id, reporter_hash)
       values (p_id, p_hash)
  on conflict do nothing;

  -- Recount rather than increment. Idempotent, and it self-heals if a row is
  -- ever deleted directly.
  update public.incident_reports
     set confirmations = (
           select count(*) from public.incident_confirmations
            where incident_id = p_id
         )
   where id = p_id;

  return query select * from public.incident_reports where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Retention.
--
-- Live emergency positions are the most sensitive data this product holds, and
-- the least useful once the emergency is over. Run this on a schedule (Supabase
-- cron, or pg_cron) rather than keeping trails indefinitely.
-- ---------------------------------------------------------------------------

create or replace function public.prune_safety_data()
returns void
language sql
security definer
set search_path = public
as $$
  update public.sos_alerts
     set status = 'expired'
   where status = 'active'
     and opened_at < now() - interval '6 hours';

  -- Drop the position trail from finished alerts after a day. The alert row
  -- stays for the record; the minute-by-minute movements of a person in
  -- distress do not need to.
  update public.sos_alerts
     set trail = '[]'::jsonb
   where status <> 'active'
     and opened_at < now() - interval '1 day'
     and trail <> '[]'::jsonb;

  delete from public.incident_reports
   where at < now() - interval '30 days';
$$;
