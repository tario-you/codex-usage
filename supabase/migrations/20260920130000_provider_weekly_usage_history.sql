-- Separate provider histories before aggregation; retain the existing combined RPC for older clients.
create or replace function public.list_dashboard_provider_weekly_usage_history(
  range_start timestamptz,
  usage_provider text,
  bucket_seconds integer default 900
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
      and ((usage_provider = 'claude' and acct.account_key like 'claude:%')
        or (usage_provider = 'codex' and acct.account_key not like 'claude:%'))
  ),
  bucket as (
    select greatest(60, coalesce(bucket_seconds, 900))::bigint as seconds
  ),
  event_times as (
    select distinct least(
      to_timestamp(ceil(extract(epoch from snap.fetched_at) / bucket.seconds) * bucket.seconds),
      now()
    ) as fetched_at
    from public.codex_usage_snapshots as snap
    join accessible_accounts as acct
      on acct.id = snap.account_id
    cross join bucket
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

revoke all on function public.list_dashboard_provider_weekly_usage_history(timestamptz, text, integer)
  from public;
grant execute on function public.list_dashboard_provider_weekly_usage_history(timestamptz, text, integer)
  to authenticated;
