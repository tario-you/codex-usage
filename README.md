# Codex Usage Dashboard

Multi-user Codex usage tracking with a Vercel-hosted dashboard, Supabase Auth, and a one-line CLI pairing flow.

## Stack

- Vite + TanStack Router + React Query
- Supabase Auth + Postgres
- Vercel Functions for pairing and sync ingest
- Local Codex access through `codex app-server`

## What changed

This repo no longer treats the dashboard as a public read-only board.

- Users sign in on the website first.
- The website creates a short-lived pairing command.
- The local machine runs one CLI command against its existing Codex install.
- Vercel receives sync payloads and writes them to Supabase with the service-role key.
- Row-level security keeps each signed-in user scoped to their own accounts and snapshots.

## Local setup

1. Start Docker Desktop.
2. Run `npm install`.
3. Run `npm run setup:local`.
4. Run `supabase db reset`.
5. Run `npm run dev`.
6. Open `http://localhost:5173`.

The Vite dev server now serves the local pairing and sync API routes under `/api/*`.

## Hosted setup

1. Link the repo to a hosted Supabase project with `supabase link --project-ref <ref>`.
2. Run `npm run setup:hosted`.
3. Set these Vercel environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy to Vercel.

`npm run setup:hosted` now writes the local env files and pushes any pending hosted Supabase migrations.

## Pairing flow

1. Sign in on the website.
2. Click `Create pairing command`.
3. Run the generated command on the machine that already has Codex installed.

The generated command looks like:

```bash
npx codex-usage pair "https://your-site.vercel.app/api/pair/complete?token=..."
```

That command:

- starts a local `codex app-server`
- reads the current Codex account and rate limits
- exchanges the pairing token for a device token
- stores the device token under `CODEX_HOME` in `codex-usage-sync.json`
- pushes the first snapshot to the dashboard

## Live sync after pairing

To keep syncing from that machine:

```bash
npx codex-usage sync --watch
```

The saved device token is read from the same Codex home that the CLI uses.

## Dev scripts

- `npm run pair -- "<pair-url>"`: local version of the published pairing command
- `npm run sync -- --watch`: local version of the watch command
- `npm run collector`: legacy single-operator collector script

## Notes

- The Vercel API routes live in `api/`.
- Pairing and device state live in `codex_pairing_sessions` and `codex_devices`.
- Existing rows without an owner remain in the database but are hidden by RLS from signed-in users.
