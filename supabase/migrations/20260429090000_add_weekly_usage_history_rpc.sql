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
          when latest_snapshot.id is null then 0
          else greatest(
            0,
            least(100, 100 - coalesce(latest_snapshot.secondary_used_percent, 0))
          )
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
      snap.secondary_used_percent
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
