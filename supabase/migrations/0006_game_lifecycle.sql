-- Greyhound Relay — game lifecycle (status, setup metadata, End Game)

alter table public.games
  add column status text not null default 'in_progress' check (status in ('in_progress', 'complete')),
  add column opponent text,
  add column is_home boolean,
  -- Which mode the game should open in before its first play is logged
  -- (set from the Game Setup Screen's "who receives" choice). Only
  -- meaningful pre-first-play; the play log is authoritative afterward.
  add column starting_mode text check (starting_mode in ('OFFENSE', 'DEFENSE'));

-- "End Game" updates an existing row's status — only INSERT was
-- previously granted/policied for games.
grant update on public.games to authenticated;

create policy "staff can update games"
  on public.games for update
  to authenticated
  using (public.is_allowed_staff())
  with check (public.is_allowed_staff());
