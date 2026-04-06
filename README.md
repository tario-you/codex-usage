# Codex Usage Dashboard

Multi-user Codex usage tracking with a Vercel-hosted dashboard, Supabase Auth, and both direct `npx` connect and website pairing flows.

## Stack

- Vite + TanStack Router + React Query
- Supabase Auth + Postgres
- Vercel Functions for pairing and sync ingest
- Local Codex access through a bundled `@openai/codex` `app-server`

## What changed

This repo no longer treats the dashboard as a public read-only board.

- Users can start from the website with Google, or from the terminal with a one-line `npx` command.
- The direct terminal path provisions a dashboard session, opens the browser, and stores the local sync token under `CODEX_HOME`.
- The website pairing flow is still available and now emits `npx` commands instead of `curl | node`.
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
   - It defaults Supabase Auth redirects to `https://codex-use-age-tario-yous-projects.vercel.app`.
   - Set `HOSTED_SITE_URL=https://your-hostname` first if you want a different canonical hosted origin.
   - Set `HOSTED_ADDITIONAL_REDIRECT_URLS=https://extra-origin-one,https://extra-origin-two` if you also browse from extra aliases like `https://codexusage.vercel.app`.
3. Set these Vercel environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. In Supabase Auth settings, enable `Manual linking` if you want guest dashboard sessions to upgrade into Google later.
5. If you want the website-first flow, enable the Google provider in Supabase Auth.
6. Deploy to Vercel.

`npm run setup:hosted` now writes the local env files, pushes the hosted Supabase Auth redirect config, and applies any pending hosted migrations.

## Direct connect flow

Run this on any machine:

```bash
npx codex-usage-dashboard@latest connect --site "https://codex-use-age-tario-yous-projects.vercel.app"
```

For local development in this repo, use:

```bash
npm run connect -- --site "http://localhost:5173"
```

The package now brings a compatible `@openai/codex` CLI dependency with it, so `connect`, `pair`, and `sync` do not require a separate global Codex install.

If the machine has never logged into Codex before, authenticate once with:

```bash
npx @openai/codex@latest login
```

That command:

- starts a local `codex app-server`
- reads the current Codex account and rate limits
- provisions a dashboard owner session without requiring Google first
- opens the hosted dashboard in the browser
- stores the device token under `CODEX_HOME` in `codex-usage-sync.json`
- pushes the first snapshot to the dashboard

If the same machine is already connected, rerun the same command to reopen the dashboard and refresh the local snapshot.

## Website pairing flow

1. Sign in on the website.
2. Click `Create pairing command`.
3. Run the generated command on the machine you want to pair.

The generated command looks like:

```bash
npx codex-usage-dashboard@latest pair "https://codex-use-age-tario-yous-projects.vercel.app/api/pair/complete?token=..."
```

## Live sync after pairing

To keep syncing from that machine:

```bash
npx codex-usage-dashboard@latest sync --watch
```

The saved device token is read from the same Codex home that the CLI uses.

## Dev scripts

- `npm run connect -- --site "<site-url>"`: local version of the direct connect command
- `npm run pair -- "<pair-url>"`: local version of the hosted pairing command
- `npm run sync -- --watch`: local version of the hosted sync command
- `npm run collector`: legacy single-operator collector script

## Publishing

1. Run `npm version patch` (or `minor` / `major`) before every new publish.
2. Run `npm run release:check` to verify the tarball contents and confirm the version is still unpublished.
3. Run `npm publish`.

`npm publish` cannot overwrite an existing version on npm, so repeating a publish for the same version will fail with `E403`.

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
- The production hostname is configured in Vercel project settings, not in this repo. This project currently uses `https://codex-use-age-tario-yous-projects.vercel.app` as its stable hosted URL.
