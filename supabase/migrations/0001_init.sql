-- Greyhound Relay — schema
--
-- Security model: any Google account can authenticate, but only emails in
-- staff_allowlist can read or write games/plays. That check happens here,
-- in RLS policies, not in client code — see is_allowed_staff() below.

create extension if not exists pgcrypto;

-- Staff allowed to use the app. Not exposed to clients directly; only
-- readable through the security-definer is_allowed_staff() function.
create table if not exists public.staff_allowlist (
  email text primary key
);

alter table public.staff_allowlist enable row level security;
-- No policies are defined, so PostgREST/anon/authenticated clients get zero
-- direct access. Manage this table from the Supabase SQL editor or
-- dashboard.

create or replace function public.is_allowed_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_allowlist
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

grant execute on function public.is_allowed_staff() to authenticated;

-- One row per calendar date, auto-created by whichever role opens the app
-- first that day. Keeps the coach from ever having to pick or type a game.
create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  game_date date not null unique,
  created_at timestamptz not null default now()
);

alter table public.games enable row level security;

create policy "staff can read games"
  on public.games for select
  to authenticated
  using (public.is_allowed_staff());

create policy "staff can create games"
  on public.games for insert
  to authenticated
  with check (public.is_allowed_staff());

-- Append-only log of full game-state snapshots. Every booth tap (mode
-- switch, new drive, an exception flag, a logged result) inserts a new row
-- with the complete current state; the sideline just watches for the
-- newest row per game. This is also the play log for postgame reporting
-- (down/distance/result) called for in the original Phase 2 plan — rows
-- where result_type is null are intermediate presnap-state updates, not
-- plays, so reports should filter on result_type is not null.
create table if not exists public.plays (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,

  drive_number int not null check (drive_number >= 1),
  mode text not null check (mode in ('OFFENSE', 'DEFENSE')),

  down int not null check (down between 1 and 4),
  distance int not null check (distance >= 0),
  -- Yards to the opponent's goal line (1-99), from the point of view of
  -- whichever team currently has the ball.
  field_position int not null check (field_position between 1 and 99),

  -- Exception flag, not a headcount — CLEAN unless the booth flags it.
  personnel text not null default 'CLEAN' check (personnel in ('CLEAN', 'SHORT', 'OVER')),

  -- Offense-only presnap reads; null in DEFENSE mode.
  flat text check (flat in ('SET', 'DEFENDER')),
  splits text check (splits in ('NONE', 'FLANKER_TIGHT', 'SLOT_TIGHT', 'BOTH_TIGHT')),

  -- Defense-only presnap read; null in OFFENSE mode.
  formation text check (formation in ('OPEN', 'CLOSED')),

  -- Set only on the row that logs a play's outcome; null on rows that are
  -- just a presnap-state update (mode switch, exception tap, new drive).
  result_type text check (result_type in ('RUN', 'PASS_COMPLETE', 'PASS_INCOMPLETE', 'PENALTY', 'TURNOVER', 'SCORE')),
  result_yards int,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  constraint plays_mode_fields_check check (
    (mode = 'OFFENSE' and flat is not null and splits is not null and formation is null)
    or
    (mode = 'DEFENSE' and formation is not null and flat is null and splits is null)
  )
);

create index if not exists plays_game_id_created_at_idx
  on public.plays (game_id, created_at desc);

alter table public.plays enable row level security;

create policy "staff can read plays"
  on public.plays for select
  to authenticated
  using (public.is_allowed_staff());

create policy "staff can create plays"
  on public.plays for insert
  to authenticated
  with check (public.is_allowed_staff() and created_by = auth.uid());

-- Turn on Realtime for the sideline screen's live subscription.
alter publication supabase_realtime add table public.plays;
