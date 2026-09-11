-- ---------------------------------------------------------------------------
-- Find Me — migration 0001: the address graph
--
-- Master document, Part III, 3.3:
--   "This schema must exist in the first migration. Retrofitting it loses
--    every early user's data."
--
-- So this is migration 0001, before auth, before trips, before anything else.
-- Every resolution attempt is recorded whether or not it succeeded, because
-- the failures are what tell us where the engine is weak, and the corrections
-- are the training signal that no competitor is collecting.
-- ---------------------------------------------------------------------------

-- IDs use gen_random_uuid(), built into Postgres 13+. Not uuid-ossp: on
-- Supabase that extension lives in the `extensions` schema, which is not on
-- the search path `supabase db push` migrates with, so its functions do not
-- resolve here.

-- ---------------------------------------------------------------------------
-- resolutions — one row per attempt to turn a phrase into a point
-- ---------------------------------------------------------------------------

create type confidence_band as enum ('high', 'moderate', 'low');

create table resolutions (
  id                uuid primary key default gen_random_uuid(),
  -- Nullable: resolution must work before sign-in, and anonymous attempts are
  -- still valuable data.
  user_id           uuid references auth.users (id) on delete set null,

  -- Exactly what the user said. Never normalise this column — the mess is the
  -- research data. Normalised forms belong in parsed_components.
  raw_phrase        text        not null,
  parsed_components jsonb       not null default '{}'::jsonb,

  -- Every candidate offered, in rank order, frozen as shown.
  candidates_shown  jsonb       not null default '[]'::jsonb,
  -- Landmarks resolved and used: [{anchor, name, lat, lng}]
  anchors_used      jsonb       not null default '[]'::jsonb,

  band              confidence_band not null,
  top_score         numeric(5, 4),
  margin            numeric(5, 4),

  -- Where the engine landed. Null when nothing cleared the floor.
  chosen_lat        double precision,
  chosen_lng        double precision,
  chosen_place_id   text,

  -- The valuable columns. A correction says exactly how the ranking was wrong
  -- AND where the truth was — far stronger signal than a confirmation.
  user_corrected    boolean     not null default false,
  corrected_lat     double precision,
  corrected_lng     double precision,

  city              text,
  -- Which provider implementations served this, so results stay comparable
  -- after a provider swap.
  providers         jsonb       not null default '{}'::jsonb,

  created_at        timestamptz not null default now(),
  confirmed_at      timestamptz,

  -- A correction without a destination is not a correction.
  constraint corrected_has_point check (
    user_corrected = false
    or (corrected_lat is not null and corrected_lng is not null)
  )
);

comment on table resolutions is
  'Every phrase-to-point attempt. The informal-address graph is built from this table.';
comment on column resolutions.raw_phrase is
  'Verbatim user input. Do not clean, normalise or trim — the noise is the dataset.';

create index resolutions_user_idx     on resolutions (user_id, created_at desc);
create index resolutions_city_idx     on resolutions (city, created_at desc);
create index resolutions_band_idx     on resolutions (band);
-- Partial index: correction review is a frequent, small query over a large table.
create index resolutions_corrected_idx on resolutions (created_at desc)
  where user_corrected = true;
-- Confirmed points feed back in as the `graph` candidate source.
create index resolutions_confirmed_point_idx on resolutions (chosen_lat, chosen_lng)
  where confirmed_at is not null;

-- ---------------------------------------------------------------------------
-- place_corrections — pin moves, denormalised for fast spatial lookup
--
-- Derivable from resolutions, but kept separate because it is read on every
-- single resolution (to down-weight points users keep moving away from) and
-- digging it out of jsonb on the hot path would not hold up.
-- ---------------------------------------------------------------------------

create table place_corrections (
  id             uuid primary key default gen_random_uuid(),
  resolution_id  uuid references resolutions (id) on delete cascade,
  user_id        uuid references auth.users (id) on delete set null,

  -- Where the engine put it.
  from_lat       double precision not null,
  from_lng       double precision not null,
  -- Where the user said it actually is.
  to_lat         double precision not null,
  to_lng         double precision not null,
  distance_m     double precision not null,

  place_id       text,
  city           text,
  created_at     timestamptz not null default now()
);

create index place_corrections_from_idx on place_corrections (from_lat, from_lng);
create index place_corrections_to_idx   on place_corrections (to_lat, to_lng);

comment on table place_corrections is
  'Every pin a user moved. Down-weights bad points and, at volume, becomes the correction layer over Google data.';

-- ---------------------------------------------------------------------------
-- landmarks — anchors people actually navigate by
--
-- Seeded from Places, then improved by usage: anchor_use_count rises each time
-- someone describes a location relative to it. That count is the thing Google
-- does not have, because Google is not listening to how people give directions.
-- ---------------------------------------------------------------------------

create table landmarks (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  -- Colloquial names and abbreviations: "JUTH" for the teaching hospital.
  aliases          text[] not null default '{}',
  category         text,

  lat              double precision not null,
  lng              double precision not null,

  city             text,
  area             text,

  -- How often this has been used as an anchor in a description.
  anchor_use_count integer not null default 0,
  -- 0..1, from review counts or equivalent.
  prominence       numeric(4, 3),
  source           text not null default 'google',
  verified_at      timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index landmarks_city_area_idx on landmarks (city, area);
create index landmarks_point_idx     on landmarks (lat, lng);
create index landmarks_anchor_idx    on landmarks (anchor_use_count desc);
create index landmarks_aliases_idx   on landmarks using gin (aliases);

-- ---------------------------------------------------------------------------
-- place_aliases — the "JUTH" problem
--
-- A phrase that means a place, learned from confirmed resolutions. Global when
-- user_id is null; personal otherwise ("my office", "Mum's place").
-- ---------------------------------------------------------------------------

create table place_aliases (
  id           uuid primary key default gen_random_uuid(),
  -- Null = everyone. Set = private to that user.
  user_id      uuid references auth.users (id) on delete cascade,

  alias_text   text not null,
  place_id     text,
  lat          double precision not null,
  lng          double precision not null,

  confidence   numeric(4, 3) not null default 0.5,
  -- How many independent confirmations back this alias.
  use_count    integer not null default 1,
  learned_from text not null default 'confirmation',
  city         text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- One row per alias per scope; reuse bumps use_count instead of inserting.
  unique nulls not distinct (user_id, alias_text, city)
);

create index place_aliases_lookup_idx on place_aliases (lower(alias_text), city);

comment on table place_aliases is
  'Learned phrase-to-place mappings. Personal when user_id is set, global when null.';

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Part VII: location data is sensitive from row one. Policies land with the
-- table, never in a follow-up migration.
-- ---------------------------------------------------------------------------

alter table resolutions       enable row level security;
alter table place_corrections enable row level security;
alter table place_aliases     enable row level security;
alter table landmarks         enable row level security;

-- A user sees only their own resolution history.
create policy resolutions_own on resolutions
  for select using (auth.uid() = user_id);

create policy resolutions_insert on resolutions
  for insert with check (auth.uid() = user_id or user_id is null);

create policy resolutions_update_own on resolutions
  for update using (auth.uid() = user_id);

create policy corrections_own on place_corrections
  for select using (auth.uid() = user_id);

create policy corrections_insert on place_corrections
  for insert with check (auth.uid() = user_id or user_id is null);

-- Global aliases are readable by everyone; personal ones only by their owner.
create policy aliases_readable on place_aliases
  for select using (user_id is null or auth.uid() = user_id);

create policy aliases_write_own on place_aliases
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Landmarks are public reference data. Writes go through the service role only.
create policy landmarks_readable on landmarks
  for select using (true);

-- ---------------------------------------------------------------------------
-- Retention
--
-- Part VI: "location data has a retention policy" from the first migration.
-- Resolutions are kept because they are the research asset, but the link to
-- the person who made them is severed. Schedule via pg_cron in a later
-- migration once a retention window is chosen (Part XI, open decision 9).
-- ---------------------------------------------------------------------------

create or replace function anonymise_old_resolutions(retain interval default interval '18 months')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update resolutions
     set user_id = null
   where user_id is not null
     and created_at < now() - retain;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function anonymise_old_resolutions is
  'Severs resolutions from their author past the retention window. Keeps the address graph, drops the person.';
