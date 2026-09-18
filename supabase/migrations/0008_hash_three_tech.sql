-- Greyhound Relay — Hash mark and 3-Tech DT alignment tracking (Offense only)

alter table public.plays
  -- Ball's left/right spot on the field, recorded for post-game analysis
  -- alongside down/distance — not surfaced on Sideline.
  add column hash text check (hash in ('L', 'M', 'R')),
  -- Opposing 3-Tech DT's alignment relative to the field/boundary.
  add column three_tech text check (three_tech in ('FIELD', 'BOUNDARY', 'HEADS_UP'));

alter table public.plays
  drop constraint plays_mode_fields_check,
  add constraint plays_mode_fields_check check (
    (mode = 'OFFENSE' and flat is not null and splits is not null and formation is null
      and hash is not null and three_tech is not null)
    or
    (mode = 'DEFENSE' and formation is not null and flat is null and splits is null
      and hash is null and three_tech is null)
  );
