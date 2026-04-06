alter table public.codex_accounts
  add column if not exists owner_user_id uuid references auth.users(id) on delete cascade;

alter table public.codex_accounts
  drop constraint if exists codex_accounts_account_key_key;

alter table public.codex_accounts
  add constraint codex_accounts_owner_user_id_account_key_key
  unique (owner_user_id, account_key);

create index if not exists codex_accounts_owner_snapshot_idx
  on public.codex_accounts (owner_user_id, last_snapshot_at desc nulls last);

create table if not exists public.codex_pairing_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  pair_token_hash text not null unique,
  pair_token_preview text not null,
  status text not null default 'pending' check (
    status in ('pending', 'paired', 'revoked', 'expired')
  ),
  expires_at timestamptz not null,
  paired_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists codex_pairing_sessions_owner_created_idx
  on public.codex_pairing_sessions (owner_user_id, created_at desc);

create table if not exists public.codex_devices (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  pairing_session_id uuid references public.codex_pairing_sessions(id) on delete set null,
  device_key text not null unique,
  device_token_hash text not null unique,
  label text not null,
  machine_name text,
  codex_home text,
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default timezone('utc', now()),
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists codex_devices_owner_last_seen_idx
  on public.codex_devices (owner_user_id, last_seen_at desc);

create trigger set_codex_pairing_sessions_updated_at
before update on public.codex_pairing_sessions
for each row
execute function public.touch_updated_at();

create trigger set_codex_devices_updated_at
before update on public.codex_devices
for each row
execute function public.touch_updated_at();

drop policy if exists "read codex accounts" on public.codex_accounts;
drop policy if exists "read codex usage snapshots" on public.codex_usage_snapshots;

alter table public.codex_pairing_sessions enable row level security;
alter table public.codex_devices enable row level security;

create policy "owners read codex accounts"
on public.codex_accounts
for select
to authenticated
using (owner_user_id = auth.uid());

create policy "owners insert codex accounts"
on public.codex_accounts
for insert
to authenticated
with check (owner_user_id = auth.uid());

create policy "owners update codex accounts"
on public.codex_accounts
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

create policy "owners read codex usage snapshots"
on public.codex_usage_snapshots
for select
to authenticated
using (
  exists (
    select 1
    from public.codex_accounts as acct
    where acct.id = codex_usage_snapshots.account_id
      and acct.owner_user_id = auth.uid()
  )
);

create policy "owners insert codex usage snapshots"
on public.codex_usage_snapshots
for insert
to authenticated
with check (
  exists (
    select 1
    from public.codex_accounts as acct
    where acct.id = codex_usage_snapshots.account_id
      and acct.owner_user_id = auth.uid()
  )
);

create policy "owners update codex usage snapshots"
on public.codex_usage_snapshots
for update
to authenticated
using (
  exists (
    select 1
    from public.codex_accounts as acct
    where acct.id = codex_usage_snapshots.account_id
      and acct.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.codex_accounts as acct
    where acct.id = codex_usage_snapshots.account_id
      and acct.owner_user_id = auth.uid()
  )
);

create policy "owners read pairing sessions"
on public.codex_pairing_sessions
for select
to authenticated
using (owner_user_id = auth.uid());

create policy "owners read devices"
on public.codex_devices
for select
to authenticated
using (owner_user_id = auth.uid());

revoke select on public.codex_dashboard_accounts from anon;
grant select on public.codex_dashboard_accounts to authenticated;
