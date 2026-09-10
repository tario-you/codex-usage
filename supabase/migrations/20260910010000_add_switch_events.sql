-- Switch history. One row per account switch, task continuation or desktop
-- relaunch, whether it happened on the owner's own machine (uploaded by the
-- owner's sync CLI from the local Switchboard activity log) or on a recipient's
-- machine (decided server-side by the pool sync). Service-role only: RLS on,
-- no policies, anon/authenticated revoked; the dashboard reads through
-- /api/login/switches, which returns the caller's own history only.

create table if not exists public.codex_switch_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('device', 'grant')),
  device_id uuid references public.codex_devices(id) on delete cascade,
  grant_id uuid references public.codex_login_grants(id) on delete cascade,
  kind text not null check (kind in ('switched', 'resumed', 'relaunched')),
  from_email text,
  to_email text,
  reason text,
  occurred_at timestamptz not null,
  dedupe_key text not null unique,
  created_at timestamptz not null default timezone('utc', now()),
  check ((source = 'device' and device_id is not null) or (source = 'grant' and grant_id is not null))
);

create index if not exists codex_switch_events_owner_recent_idx
  on public.codex_switch_events (owner_user_id, occurred_at desc);

alter table public.codex_switch_events enable row level security;
revoke all on table public.codex_switch_events from anon, authenticated;
