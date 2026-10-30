-- A window whose reset has passed by a point counts full there, as the rows count it
-- (rate-limit-windows.ts) and claude-auto-switch does (projected). A plan read last
-- before its reset, such as one held only as an app sign-in while the app is on
-- another plan, otherwise kept its pre-reset room in the chart for good.
create or replace function public.list_dashboard_usage_history(
  range_start timestamptz,
  usage_provider text,
  bucket_seconds integer default 900
)
returns table (
  fetched_at timestamptz,
  total_remaining_percent numeric,
  account_count integer,
  total_capacity_percent numeric,
  effective_remaining_percent numeric
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
    coalesce(sum(capacity.weight * room.weekly), 0)::numeric as total_remaining_percent,
    count(*)::integer as account_count,
    sum(capacity.weight * 100)::numeric as total_capacity_percent,
    coalesce(sum(capacity.weight * case
      when room.session = 0 then 0
      else room.weekly
    end), 0)::numeric as effective_remaining_percent
  from event_times
  cross join accessible_accounts as acct
  left join lateral (
    select snap.primary_used_percent, snap.primary_window_mins, snap.primary_resets_at,
      snap.secondary_used_percent, snap.secondary_window_mins, snap.secondary_resets_at,
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
  cross join lateral (
    select
      case
        when latest_snapshot.primary_window_mins = 10080 and latest_snapshot.primary_used_percent is not null
          then case when latest_snapshot.primary_resets_at <= event_times.fetched_at then 100
            else greatest(0, least(100, 100 - latest_snapshot.primary_used_percent)) end
        when latest_snapshot.secondary_window_mins = 10080 and latest_snapshot.secondary_used_percent is not null
          then case when latest_snapshot.secondary_resets_at <= event_times.fetched_at then 100
            else greatest(0, least(100, 100 - latest_snapshot.secondary_used_percent)) end
        else 0
      end::numeric as weekly,
      case
        when latest_snapshot.primary_window_mins = 300 and latest_snapshot.primary_used_percent is not null
          then case when latest_snapshot.primary_resets_at <= event_times.fetched_at then 100
            else greatest(0, least(100, 100 - latest_snapshot.primary_used_percent)) end
        when latest_snapshot.secondary_window_mins = 300 and latest_snapshot.secondary_used_percent is not null
          then case when latest_snapshot.secondary_resets_at <= event_times.fetched_at then 100
            else greatest(0, least(100, 100 - latest_snapshot.secondary_used_percent)) end
      end::numeric as session
  ) as room
  group by event_times.fetched_at
  order by event_times.fetched_at;
$$;

revoke all on function public.list_dashboard_usage_history(timestamptz, text, integer) from public;
grant execute on function public.list_dashboard_usage_history(timestamptz, text, integer) to authenticated;
