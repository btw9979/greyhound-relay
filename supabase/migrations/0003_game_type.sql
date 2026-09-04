-- Greyhound Relay — practice/training mode
--
-- Games are no longer implicitly "one per calendar date" — the booth now
-- explicitly starts each game and picks real vs. practice, so multiple
-- games (several practice reps, or a practice session followed by a real
-- game) can share a date. game_date is kept as informational metadata.

alter table public.games drop constraint games_game_date_key;

alter table public.games
  add column game_type text not null default 'real' check (game_type in ('real', 'practice'));

comment on column public.games.game_type is
  'Reporting/analytics queries should filter to game_type = ''real'' by default so practice data never silently contaminates real stats.';
