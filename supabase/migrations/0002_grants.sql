-- Greyhound Relay — base table grants
--
-- RLS policies only restrict which *rows* a role can see within a table it
-- already has table-level access to. This project's public schema didn't
-- get Supabase's usual default privileges, so authenticated had no base
-- SELECT/INSERT on games or plays — Postgres rejected every request before
-- RLS was even evaluated, which PostgREST reports as 403.

grant select, insert on public.games to authenticated;
grant select, insert on public.plays to authenticated;
