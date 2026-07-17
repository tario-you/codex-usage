create table if not exists public.codex_usage_percentage_overrides (
  account_id uuid not null references public.codex_accounts(id) on delete cascade,
  window_key text not null check (window_key in ('primary', 'secondary')),
  remaining_percent integer not null check (remaining_percent between 0 and 100),
  source_snapshot_id bigint not null references public.codex_usage_snapshots(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (account_id, window_key)
);

create trigger set_codex_usage_percentage_overrides_updated_at
before update on public.codex_usage_percentage_overrides
for each row
execute function public.touch_updated_at();

alter table public.codex_usage_percentage_overrides enable row level security;

create policy "owners and viewers read usage percentage overrides"
on public.codex_usage_percentage_overrides
for select
to authenticated
using (
  exists (
    select 1
    from public.codex_accounts as acct
    where acct.id = codex_usage_percentage_overrides.account_id
      and public.user_can_access_codex_owner(acct.owner_user_id)
  )
);

grant select on public.codex_usage_percentage_overrides to authenticated;

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
    case
      when snap.primary_used_percent is null then null
      else greatest(0, least(100, 100 - snap.primary_used_percent))
    end as primary_remaining_percent,
    snap.primary_window_mins,
    snap.primary_resets_at,
    snap.secondary_used_percent,
    case
      when snap.secondary_used_percent is null then null
      else greatest(0, least(100, 100 - snap.secondary_used_percent))
    end as secondary_remaining_percent,
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
  acct.owner_user_id,
  case
    when acct.owner_user_id = auth.uid() then 'owned'
    else 'shared'
  end as access_scope,
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
  case
    when primary_override.remaining_percent is not null
      then 100 - primary_override.remaining_percent
    else latest_snapshot.primary_used_percent
  end as primary_used_percent,
  coalesce(
    primary_override.remaining_percent,
    latest_snapshot.primary_remaining_percent
  ) as primary_remaining_percent,
  latest_snapshot.primary_window_mins,
  latest_snapshot.primary_resets_at,
  case
    when secondary_override.remaining_percent is not null
      then 100 - secondary_override.remaining_percent
    else latest_snapshot.secondary_used_percent
  end as secondary_used_percent,
  coalesce(
    secondary_override.remaining_percent,
    latest_snapshot.secondary_remaining_percent
  ) as secondary_remaining_percent,
  latest_snapshot.secondary_window_mins,
  latest_snapshot.secondary_resets_at,
  latest_snapshot.credits_balance,
  latest_snapshot.has_credits,
  latest_snapshot.unlimited_credits,
  latest_snapshot.raw_rate_limits,
  latest_snapshot.raw_rate_limits_by_limit_id,
  (primary_override.remaining_percent is not null) as primary_remaining_overridden,
  (secondary_override.remaining_percent is not null) as secondary_remaining_overridden
from public.codex_accounts as acct
left join latest_snapshot
  on latest_snapshot.account_id = acct.id
left join public.codex_usage_percentage_overrides as primary_override
  on primary_override.account_id = acct.id
  and primary_override.window_key = 'primary'
  and primary_override.source_snapshot_id = latest_snapshot.snapshot_id
left join public.codex_usage_percentage_overrides as secondary_override
  on secondary_override.account_id = acct.id
  and secondary_override.window_key = 'secondary'
  and secondary_override.source_snapshot_id = latest_snapshot.snapshot_id;

grant select on public.codex_dashboard_accounts to authenticated;
