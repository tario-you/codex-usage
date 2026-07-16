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

grant select on public.codex_dashboard_accounts to authenticated;

create or replace function public.list_dashboard_weekly_usage_history(
  range_start timestamptz
)
returns table (
  fetched_at timestamptz,
  total_remaining_percent integer,
  account_count integer,
  total_capacity_percent integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with accessible_accounts as (
    select acct.id
    from public.codex_accounts as acct
    where public.user_can_access_codex_owner(acct.owner_user_id)
  ),
  event_times as (
    select distinct snap.fetched_at
    from public.codex_usage_snapshots as snap
    join accessible_accounts as acct
      on acct.id = snap.account_id
    where snap.fetched_at >= range_start
  ),
  account_total as (
    select count(*)::integer as value
    from accessible_accounts
  )
  select
    event_times.fetched_at,
    coalesce(
      sum(
        case
          when latest_snapshot.primary_window_mins = 10080
            and latest_snapshot.primary_used_percent is not null
          then greatest(
            0,
            least(100, 100 - latest_snapshot.primary_used_percent)
          )
          when latest_snapshot.secondary_window_mins = 10080
            and latest_snapshot.secondary_used_percent is not null
          then greatest(
            0,
            least(100, 100 - latest_snapshot.secondary_used_percent)
          )
          else 0
        end
      ),
      0
    )::integer as total_remaining_percent,
    account_total.value as account_count,
    (account_total.value * 100)::integer as total_capacity_percent
  from event_times
  cross join account_total
  cross join accessible_accounts as acct
  left join lateral (
    select
      snap.id,
      snap.primary_used_percent,
      snap.primary_window_mins,
      snap.secondary_used_percent,
      snap.secondary_window_mins
    from public.codex_usage_snapshots as snap
    where snap.account_id = acct.id
      and snap.fetched_at <= event_times.fetched_at
    order by snap.fetched_at desc, snap.id desc
    limit 1
  ) as latest_snapshot on true
  group by event_times.fetched_at, account_total.value
  order by event_times.fetched_at;
$$;

revoke all on function public.list_dashboard_weekly_usage_history(timestamptz)
  from public;
grant execute on function public.list_dashboard_weekly_usage_history(timestamptz)
  to authenticated;
