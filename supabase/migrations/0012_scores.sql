-- Greyhound Relay — scoring capture: score records (refs #3)
--
-- One row per score (TD/FG/SAFETY), optionally linked to the plays row that
-- produced it. Not every score has one: a KR/INT/FR return-for-TD and a
-- "no play" safety record no offensive play at all (see plays.result_type
-- additions below), so play_id is nullable and ON DELETE SET NULL rather
-- than CASCADE — losing the play shouldn't silently delete score history.
--
-- The conversion (PAT/2-point) is recorded on the same row as the TD, via
-- UPDATE after the TD row is inserted (the booth logs the TD first, then
-- the conversion outcome) — hence the update policy below, not just
-- select/insert.

create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  play_id uuid references public.plays (id) on delete set null,

  quarter text not null check (quarter in ('Q1', 'Q2', 'Q3', 'Q4', 'OT')),
  -- mm:ss as typed/displayed by the booth (e.g. "1:27"); optional.
  clock text,

  scoring_team text not null check (scoring_team in ('us', 'opponent')),
  score_type text not null check (score_type in ('TD', 'FG', 'SAFETY')),

  -- TD only — how the score happened.
  method text check (method in ('RUN', 'PASS', 'INT', 'FR', 'KR')),

  -- Scoring-play distance (Run/Pass TD), return distance (INT/FR/KR),
  -- or kick distance (FG). Not meaningful for SAFETY.
  distance_yards int check (distance_yards >= 0),

  -- Ball carrier/receiver/returner (TD), kicker (FG), or tackler (SAFETY).
  player_number text,
  player_name text,
  -- Passer — TD passing plays only (method = 'PASS').
  passer_number text,
  passer_name text,

  -- FG only.
  fg_result text check (fg_result in ('GOOD', 'NO_GOOD')),

  -- TD only — conversion attempt, recorded via a follow-up UPDATE.
  conversion_type text check (conversion_type in ('PAT', 'TWO_POINT', 'NONE')),
  -- 2-point only; a PAT is always a kick.
  conversion_method text check (conversion_method in ('RUN', 'PASS')),
  conversion_result text check (conversion_result in ('GOOD', 'NO_GOOD')),
  conversion_player_number text,
  conversion_player_name text,
  -- 2-point pass only.
  conversion_passer_number text,
  conversion_passer_name text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  constraint scores_type_fields_check check (
    case score_type
      when 'TD' then fg_result is null
      when 'FG' then
        method is null
        and conversion_type is null
        and conversion_method is null
        and conversion_result is null
        and conversion_player_number is null
        and conversion_player_name is null
        and conversion_passer_number is null
        and conversion_passer_name is null
      when 'SAFETY' then
        method is null
        and fg_result is null
        and conversion_type is null
        and conversion_method is null
        and conversion_result is null
        and conversion_player_number is null
        and conversion_player_name is null
        and conversion_passer_number is null
        and conversion_passer_name is null
      else false
    end
  )
);

create index if not exists scores_game_id_created_at_idx
  on public.scores (game_id, created_at desc);

grant select, insert, update on public.scores to authenticated;

alter table public.scores enable row level security;

create policy "staff can read scores"
  on public.scores for select
  to authenticated
  using (public.is_allowed_staff());

create policy "staff can create scores"
  on public.scores for insert
  to authenticated
  with check (public.is_allowed_staff() and created_by = auth.uid());

-- Not creator-restricted (matches "staff can update games") — the
-- conversion is routinely recorded moments after the TD row, but a reload
-- or handoff between booth operators shouldn't block it.
create policy "staff can update scores"
  on public.scores for update
  to authenticated
  using (public.is_allowed_staff())
  with check (public.is_allowed_staff());

-- New plays.result_type values this update introduces:
--   INTERCEPTION — offense's failed pass attempt, picked off (counts as a
--     pass attempt, not a completion; see computeGameStats).
--   FIELD_GOAL   — marker row for an FG attempt (good or no good); not a
--     play. Replaces the old workaround of logging FGs as a Turnover.
--   SAFETY       — marker row for a "no play" safety (penalty/bad snap in
--     the end zone, etc.); not a play. A Run/Sack safety instead reuses the
--     existing RUN/SACK result_type with negative yardage, so it counts
--     toward rushing/sack stats normally — no new value needed for those.
alter table public.plays drop constraint plays_result_type_check;

alter table public.plays
  add constraint plays_result_type_check check (
    result_type in (
      'RUN', 'PASS_COMPLETE', 'PASS_INCOMPLETE', 'SACK', 'PENALTY',
      'TURNOVER', 'SCORE', 'INTERCEPTION', 'FIELD_GOAL', 'SAFETY'
    )
  );
