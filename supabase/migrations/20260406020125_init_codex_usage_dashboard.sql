create extension if not exists pgcrypto with schema extensions;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.codex_accounts (
  id uuid primary key default gen_random_uuid(),
  account_key text not null unique,
  email text,
  plan_type text,
  display_name text,
  source_key text not null,
  source_label text,
  codex_home text,
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default timezone('utc', now()),
  last_snapshot_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.codex_usage_snapshots (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.codex_accounts(id) on delete cascade,
  source_key text not null,
  fetched_at timestamptz not null default timezone('utc', now()),
  primary_used_percent integer check (
    primary_used_percent is null or primary_used_percent between 0 and 100
  ),
  primary_window_mins integer,
  primary_resets_at timestamptz,
  secondary_used_percent integer check (
    secondary_used_percent is null or secondary_used_percent between 0 and 100
  ),
  secondary_window_mins integer,
  secondary_resets_at timestamptz,
  credits_balance numeric,
  has_credits boolean,
  unlimited_credits boolean,
  raw_rate_limits jsonb not null,
  raw_rate_limits_by_limit_id jsonb not null default '{}'::jsonb
);

create index if not exists codex_accounts_last_snapshot_idx
  on public.codex_accounts (last_snapshot_at desc nulls last);

create index if not exists codex_usage_snapshots_account_fetch_idx
  on public.codex_usage_snapshots (account_id, fetched_at desc, id desc);

create trigger set_codex_accounts_updated_at
before update on public.codex_accounts
for each row
execute function public.touch_updated_at();

alter table public.codex_accounts enable row level security;
alter table public.codex_usage_snapshots enable row level security;

create policy "read codex accounts"
on public.codex_accounts
for select
to anon, authenticated
using (true);

create policy "read codex usage snapshots"
on public.codex_usage_snapshots
for select
to anon, authenticated
using (true);

create or replace view public.codex_dashboard_accounts
with (security_invoker = true)
as
with latest_snapshot as (
  select distinct on (snap.account_id)
    snap.id as snapshot_id,
    snap.account_id,
    snap.source_key,
    snap.fetched_at,
    snap.primary_used_percent,
    greatest(0, least(100, 100 - coalesce(snap.primary_used_percent, 0)))
      as primary_remaining_percent,
    snap.primary_window_mins,
    snap.primary_resets_at,
    snap.secondary_used_percent,
    greatest(0, least(100, 100 - coalesce(snap.secondary_used_percent, 0)))
      as secondary_remaining_percent,
    snap.secondary_window_mins,
    snap.secondary_resets_at,
    snap.credits_balance,
    snap.has_credits,
    snap.unlimited_credits,
    snap.raw_rate_limits,
    snap.raw_rate_limits_by_limit_id
  from public.codex_usage_snapshots as snap
  order by snap.account_id, snap.fetched_at desc, snap.id desc
)
select
  acct.id,
  acct.account_key,
  acct.email,
  coalesce(acct.display_name, acct.email, acct.source_label, acct.source_key) as label,
  acct.plan_type,
  acct.source_key,
  acct.source_label,
  acct.codex_home,
  acct.metadata,
  acct.last_seen_at,
  acct.last_snapshot_at,
  latest_snapshot.snapshot_id,
  latest_snapshot.fetched_at,
  latest_snapshot.primary_used_percent,
  latest_snapshot.primary_remaining_percent,
  latest_snapshot.primary_window_mins,
  latest_snapshot.primary_resets_at,
  latest_snapshot.secondary_used_percent,
  latest_snapshot.secondary_remaining_percent,
  latest_snapshot.secondary_window_mins,
  latest_snapshot.secondary_resets_at,
  latest_snapshot.credits_balance,
  latest_snapshot.has_credits,
  latest_snapshot.unlimited_credits,
  latest_snapshot.raw_rate_limits,
  latest_snapshot.raw_rate_limits_by_limit_id
from public.codex_accounts as acct
left join latest_snapshot
  on latest_snapshot.account_id = acct.id;

grant select on public.codex_dashboard_accounts to anon, authenticated;
