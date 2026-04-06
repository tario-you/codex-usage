# Codex Usage Dashboard

One dashboard for up to three separate Codex accounts, backed by Supabase snapshots.

## Stack

- TanStack Router + React Query
- shadcn/ui + Tailwind CSS v4
- Supabase Postgres for account rows and immutable usage snapshots
- A local collector that talks to `codex app-server`

## What the repo includes

- `src/`: dashboard UI that reads the latest account view from Supabase
- `scripts/codex-collector.ts`: the local background collector
- `supabase/migrations/`: schema for accounts, snapshots, and the `codex_dashboard_accounts` view
- `collector.sources.example.json`: three source slots you can enable
- `ops/com.codex-usage.collector.plist`: a launchd agent for macOS background execution

## Local setup

1. Start Docker Desktop. The local Supabase stack needs Docker.
2. Run `supabase start`.
3. Run `supabase db reset`.
4. Run `supabase status` and copy the local URL, anon key, and service role key.
5. Copy `.env.example` to `.env.local` for the app and `.env.collector.local` for the collector.
6. Copy `collector.sources.example.json` to `collector.sources.json`.
7. Run `npm run dev`.
8. In another terminal, run `npm run collector`.

## Background collector

The collector supports two patterns:

- `default-home`: watches your normal `~/.codex` so a new login gets discovered automatically
- dedicated slots: keep extra `CODEX_HOME` directories alive in the background so multiple accounts keep refreshing at once

Each source can either:

- connect to an existing `codex app-server` WebSocket
- spawn its own `codex app-server --listen ws://127.0.0.1:<port>`

Snapshots are written to Supabase on:

- startup
- `account/updated`
- `account/login/completed`
- `account/rateLimits/updated`
- a periodic poll interval

## macOS launchd

To keep the collector running in the background:

1. Copy `ops/com.codex-usage.collector.plist` to `~/Library/LaunchAgents/`.
2. Run `launchctl load -w ~/Library/LaunchAgents/com.codex-usage.collector.plist`.
3. Check `.collector.log` and `.collector.error.log` in the repo if something fails.

## Notes

- The dashboard intentionally keeps old accounts visible with `last updated` instead of removing them.
- This repo was initialized with Supabase CLI, but the local stack will not start until Docker is running.
