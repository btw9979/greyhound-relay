# Greyhound Relay

Booth-to-sideline presnap relay and game log for Lisbon High School Greyhounds
football. See `greyhound-relay-plan` at the repo root for the full spec.

## Stack

- **Frontend:** Next.js (App Router) + Tailwind, deployed on Vercel.
- **Backend:** Supabase — Postgres, Auth (Google), Realtime.

## Environments

There are two Supabase projects. The environment an app instance runs in
decides which one it talks to — never the type of game. A practice game
created in production lives in the production database.

| Environment                         | Supabase project                | Configured in                          |
| ----------------------------------- | ------------------------------- | -------------------------------------- |
| Local (`npm run dev`)               | **Dev** — `hhabhhqkavnrklidagnb` | `.env.local`                           |
| Vercel Preview (feature branches)   | **Dev** — `hhabhhqkavnrklidagnb` | Vercel env vars (Preview/Development)  |
| Vercel Production (`main`)          | **Prod** — `oonwvqfnfckidhweancr` | Vercel env vars (Production)           |

Both projects have Google sign-in configured with their own redirect URLs
(`<origin>/auth/callback`), and each has its own `staff_allowlist`.

The Supabase CLI in this repo stays linked to the **dev** project.
Migrations are applied to dev with the linked CLI; production is only
touched deliberately, with an explicit `--db-url` (see below).

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.local.example` to `.env.local` and fill in the **dev**
   project's URL and anon key (Project Settings → API).

3. Log in to the Supabase CLI and link it to the dev project (prompts for
   the dev database password):

   ```bash
   npx supabase login
   npx supabase link --project-ref hhabhhqkavnrklidagnb
   ```

4. Apply migrations to dev:

   ```bash
   npx supabase db push
   ```

5. Add staff emails to the dev allowlist: copy `supabase/seed.sql.example`
   to `supabase/seed.sql` (gitignored), edit the emails, and run it against
   the linked dev project (the insert is idempotent, so re-running is safe):

   ```bash
   npx supabase db push --include-seed
   ```

6. Run the dev server:

   ```bash
   npm run dev
   ```

## Development workflow

1. Build each feature on its own branch (e.g. `feature/game-history`),
   never directly on `main`.
2. Commit messages reference the GitHub issue with `refs #N`.
3. New migrations go in `supabase/migrations/` and are applied to **dev
   only** (`npx supabase db push`).
4. Push the branch and open a pull request whose description says
   `closes #N`. Vercel builds a preview deployment against the dev
   database; test there.
5. Before merging, apply any new migrations to production (next section).
6. Merge the pull request. Vercel deploys `main` to production.

## Applying a migration to production

Production migrations are applied by hand, with the connection string
passed explicitly so the CLI's dev link is never changed.

1. Get the production connection string: Supabase dashboard → prod project
   (`oonwvqfnfckidhweancr`) → **Connect** → Session pooler. It looks like
   `postgresql://postgres.oonwvqfnfckidhweancr:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   The password must be percent-encoded if it contains special characters.
   Keep it in a shell variable rather than typing it into commands:

   ```bash
   read -rs PROD_DB_URL   # paste the connection string, press Enter
   ```

2. Preview what would be applied:

   ```bash
   npx supabase db push --db-url "$PROD_DB_URL" --dry-run
   ```

   It should list only the new migration(s) you expect.

3. Apply:

   ```bash
   npx supabase db push --db-url "$PROD_DB_URL"
   ```

4. Confirm both projects have matching migration lists:

   ```bash
   npx supabase migration list                         # dev (linked)
   npx supabase migration list --db-url "$PROD_DB_URL" # prod
   ```

   In each output, every row should have the same version in both the
   **Local** and **Remote** columns, and the two outputs should list the
   same versions. A blank Remote cell means that migration hasn't been
   applied to that database yet.

## How it works

- **Auth:** Any Google account can sign in, but reads/writes to the
  `games` and `plays` tables are gated by Postgres RLS policies checking a
  `staff_allowlist` table — enforced server-side, not just hidden in the
  client. See `supabase/migrations/0001_init.sql`.
- **Games:** One row per calendar date, auto-created by whichever role
  opens the app first that day — no manual game setup.
- **Plays:** Each booth tap (mode switch, new drive, an exception flag, a
  logged result) inserts a full game-state snapshot into the append-only
  `plays` table — game/drive/down/distance/field position plus whichever
  presnap reads apply to the current mode. The sideline screen subscribes
  to new rows via Supabase Realtime and always shows the latest one, with
  a freshness indicator based on how long ago that row landed. Rows where
  `result_type` is set are logged plays (for postgame reporting); rows
  where it's null are just presnap-state updates.
- **Offense/defense mode:** The booth manually toggles OFFENSE/DEFENSE
  when possession changes (no auto-detection). Personnel and the
  down/distance/drive/field-position state are shared; Flat and Splits
  only apply in OFFENSE, Formation only in DEFENSE — see
  `src/lib/plays.ts` for the shared field logic and the down/distance/
  field-position auto-calc engine (`applyRunOrPassResult`), and
  `greyhound-relay-update-2026-09-02` at the repo root for the full spec
  this was built from.
- **Role:** Booth vs. sideline is chosen once and stored in
  `localStorage` per device; a "Switch role" control is always visible.
