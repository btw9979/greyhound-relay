-- Down becomes a 5-value marker: 1-4 for numbered downs, plus 'P' — used
-- exclusively for the first play of a new drive (replacing the old
-- standalone NEW DRIVE button's implicit "always start at 1st & 10").
-- Drop the int-typed check constraint before retyping, since its
-- expression can't be validated against the new text column.
alter table public.plays drop constraint plays_down_check;

alter table public.plays alter column down type text using down::text;

alter table public.plays
  add constraint plays_down_check check (down in ('1', '2', '3', '4', 'P'));
