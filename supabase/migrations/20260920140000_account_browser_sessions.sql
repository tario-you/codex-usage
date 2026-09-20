-- Browser launches are explicit owner requests to an already paired local helper.
-- No provider credentials or browser cookies are stored here.
alter table public.codex_devices add column browser_agent_seen_at timestamptz;
create table public.codex_browser_launches (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.codex_devices(id) on delete cascade,
  account_id uuid not null references public.codex_accounts(id) on delete cascade,
  provider text not null check (provider in ('codex', 'claude')),
  email text not null,
  state text not null default 'queued' check (state in ('queued', 'opening', 'opened', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 seconds'
);
create unique index codex_browser_launches_one_queued on public.codex_browser_launches(device_id) where state = 'queued';
alter table public.codex_browser_launches enable row level security;
revoke all on public.codex_browser_launches from anon, authenticated;
grant all on public.codex_browser_launches to service_role;
