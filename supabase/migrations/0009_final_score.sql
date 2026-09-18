-- Greyhound Relay — final score on the EoG summary

alter table public.games
  add column final_score_us int check (final_score_us >= 0),
  add column final_score_opponent int check (final_score_opponent >= 0);
