-- The sideline screen needs to notice, live, when the booth starts a new
-- game (e.g. switching from a real game to practice reps) without a reload.
alter publication supabase_realtime add table public.games;
