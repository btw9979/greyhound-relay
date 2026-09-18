-- Greyhound Relay — distinguish Run vs. Pass touchdowns
--
-- A scoring play is still logged as result_type = 'SCORE' (unchanged —
-- that's what drives drive-ending/mode-flip behavior), but that alone
-- doesn't say whether it was a run or a pass, so the EoG summary's Rush
-- and Pass breakouts couldn't include a TD's yardage in either category.

alter table public.plays
  add column score_play_type text check (score_play_type in ('RUN', 'PASS_COMPLETE'));
