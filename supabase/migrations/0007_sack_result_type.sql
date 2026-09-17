-- Greyhound Relay — add SACK as its own result_type

alter table public.plays
  drop constraint plays_result_type_check,
  add constraint plays_result_type_check
    check (result_type in ('RUN', 'PASS_COMPLETE', 'PASS_INCOMPLETE', 'SACK', 'PENALTY', 'TURNOVER', 'SCORE'));
