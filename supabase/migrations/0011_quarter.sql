-- Greyhound Relay — quarter tracking (closes #1)
--
-- Existing rows predate this feature and have no quarter — left null,
-- not backfilled/guessed. The check constraint is added NOT VALID so it
-- skips validating those rows, while still enforcing a real value on every
-- new insert going forward (plays is append-only, so existing rows are
-- never updated and never re-checked).

alter table public.plays add column quarter text;

alter table public.plays
  add constraint plays_quarter_check check (quarter in ('Q1', 'Q2', 'Q3', 'Q4', 'OT')) not valid;
