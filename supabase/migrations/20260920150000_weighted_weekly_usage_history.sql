-- Owner-defined units: 100% of Codex ProLite = 25% of Codex Pro.
-- A new RPC keeps older clients' unweighted forecasts internally consistent.
create or replace function public.list_dashboard_weighted_weekly_usage_history(
  range_start timestamptz,
  usage_provider text,
  bucket_seconds integer default 900
)
returns table (
  fetched_at timestamptz,
  total_remaining_percent numeric,
  account_count integer,
  total_capacity_percent numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with accessible_accounts as (
    select acct.id, acct.plan_type
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
    join accessible_accounts as acct on acct.id = snap.account_id
    cross join bucket
    where snap.fetched_at >= range_start
  )
  select
    event_times.fetched_at,
    coalesce(sum(
      capacity.weight * case
        when latest_snapshot.primary_window_mins = 10080 and latest_snapshot.primary_used_percent is not null
          then greatest(0, least(100, 100 - latest_snapshot.primary_used_percent))
        when latest_snapshot.secondary_window_mins = 10080 and latest_snapshot.secondary_used_percent is not null
          then greatest(0, least(100, 100 - latest_snapshot.secondary_used_percent))
        else 0
      end
    ), 0)::numeric as total_remaining_percent,
    count(*)::integer as account_count,
    sum(capacity.weight * 100)::numeric as total_capacity_percent
  from event_times
  cross join accessible_accounts as acct
  left join lateral (
    select snap.primary_used_percent, snap.primary_window_mins,
      snap.secondary_used_percent, snap.secondary_window_mins,
      nullif(btrim(snap.raw_rate_limits->>'planType'), '') as plan_type
    from public.codex_usage_snapshots as snap
    where snap.account_id = acct.id and snap.fetched_at <= event_times.fetched_at
    order by snap.fetched_at desc, snap.id desc
    limit 1
  ) as latest_snapshot on true
  cross join lateral (
    select case when usage_provider = 'codex'
      and lower(btrim(coalesce(latest_snapshot.plan_type, acct.plan_type, ''))) = 'prolite'
      then 0.25::numeric else 1::numeric end as weight
  ) as capacity
  group by event_times.fetched_at
  order by event_times.fetched_at;
$$;

revoke all on function public.list_dashboard_weighted_weekly_usage_history(timestamptz, text, integer) from public;
grant execute on function public.list_dashboard_weighted_weekly_usage_history(timestamptz, text, integer) to authenticated;
