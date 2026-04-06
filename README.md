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
curl -fsSL "https://your-site.vercel.app/api/cli" | node - pair "https://your-site.vercel.app/api/pair/complete?token=..."
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
curl -fsSL "https://your-site.vercel.app/api/cli" | node - sync --watch
```

The saved device token is read from the same Codex home that the CLI uses.

## Dev scripts

- `npm run pair -- "<pair-url>"`: local version of the hosted pairing command
- `npm run sync -- --watch`: local version of the hosted sync command
- `npm run collector`: legacy single-operator collector script

## Tario-specific Git workflow for Codex

If the current machine or user context indicates Tario is the operator, treat that as a master-by-default environment.

- Use the local machine identity to decide this.
- Treat `scutil --get ComputerName` returning `tario` as the primary signal.
- Treat `/Users/__LOCAL_USER__` and the local user `__LOCAL_USER__` as reinforcing signals.
- In that Tario context, unless otherwise specified, work directly on `master`.
- If the user explicitly says to work on a branch, create or switch to that branch and work there.
- Do not create, switch to, or push feature branches by default.
- Do not default to PR-first workflows or branch-based workflows unless the user asks for them.
- This rule is specific to Tario's environment; when the operator is not Tario, normal branch workflows remain allowed.

## Notes

- The Vercel API routes live in `api/`.
- Pairing and device state live in `codex_pairing_sessions` and `codex_devices`.
- Existing rows without an owner remain in the database but are hidden by RLS from signed-in users.
