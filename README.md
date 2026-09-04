# Greyhound Relay

Booth-to-sideline presnap relay and game log for Lisbon High School Greyhounds
football. See `greyhound-relay-plan` at the repo root for the full spec.

## Stack

- **Frontend:** Next.js (App Router) + Tailwind, deployed on Vercel.
- **Backend:** Supabase — Postgres, Auth (Google), Realtime.

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a Supabase project, then in the SQL editor run the migration in
   `supabase/migrations/0001_init.sql`.

3. Add staff emails to the allowlist (copy `supabase/seed.sql.example` and
   run it, or insert rows into `staff_allowlist` directly):

   ```sql
   insert into public.staff_allowlist (email) values ('coach@example.com');
   ```

4. In Supabase Auth settings, enable the **Google** provider and set the
   redirect URL to `<your-site-origin>/auth/callback` (add both your local
   dev origin and your production Vercel origin).

5. Copy `.env.local.example` to `.env.local` and fill in your Supabase
   project URL and anon key (Project Settings → API).

6. Run the dev server:

   ```bash
   npm run dev
   ```

## Deploying

Push to GitHub and import the repo in Vercel. Set the same two
`NEXT_PUBLIC_SUPABASE_*` env vars in the Vercel project, and add the Vercel
production URL as an authorized redirect URL in both Supabase Auth and the
Google OAuth client.

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
