-- Greyhound Relay — narrow correction grant for a TD's Run/Pass type (refs #4)
--
-- plays has been append-only until now (no UPDATE grant or policy at all).
-- Edit Scoring adds exactly one exception: film sometimes shows a Run/Pass
-- TD was logged as the wrong type, and correcting it must also flip the
-- underlying play's score_play_type so rushing/passing stats stay
-- consistent with the corrected scores.method. Scoped as narrowly as
-- practical two ways:
--   - Column grant: only score_play_type is ever updatable — Postgres
--     rejects any UPDATE statement that also touches another column,
--     regardless of what the app or RLS would otherwise allow.
--   - RLS: only rows that are already a real Run/Pass TD (result_type =
--     'SCORE' with score_play_type already set) qualify. This also
--     structurally excludes every other play, including FG/SAFETY marker
--     rows and an INT/FR/KR TD's underlying play (which is never
--     result_type = 'SCORE' — see computeGameStats' doc comment), matching
--     "INT, FR, and KR methods are not editable."
-- The existing score_play_type check constraint (RUN/PASS_COMPLETE only,
-- migration 0010) still applies to any value written here.

grant update (score_play_type) on public.plays to authenticated;

create policy "staff can correct a TD's run/pass type"
  on public.plays for update
  to authenticated
  using (public.is_allowed_staff() and result_type = 'SCORE' and score_play_type is not null)
  with check (public.is_allowed_staff() and result_type = 'SCORE' and score_play_type is not null);
