@AGENTS.md

# Environments and workflow

This project has two Supabase projects:

- **Dev:** `hhabhhqkavnrklidagnb` — used by local development (`.env.local`)
  and Vercel Preview/Development deployments.
- **Production:** `oonwvqfnfckidhweancr` — used only by the Vercel
  Production deployment.

Rules for every session:

- The Supabase CLI stays linked to the dev project (`hhabhhqkavnrklidagnb`).
  Never re-link it to production.
- Never apply migrations to the production project (`oonwvqfnfckidhweancr`)
  — not via `supabase db push`, `--db-url`, the SQL editor, or any other
  route. Apply migrations to dev only. The user applies production
  migrations themselves.
- Build new features on a feature branch (e.g. `feature/game-history`).
  Never commit feature work directly to `main`.
- Commit messages reference the related GitHub issue with `refs #N`. The
  pull request that merges the branch uses `closes #N`.
- Do not merge to `main`. The user merges through pull requests after
  testing on the branch's Vercel preview deployment.
- The environment determines the database, not the type of game. Practice
  games created in production are stored in the production database. Never
  route any production data to the dev database.
