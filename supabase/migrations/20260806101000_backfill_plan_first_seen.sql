update public.codex_accounts as acct
set plan_started_at = coalesce(
  (
    select min(snap.fetched_at)
    from public.codex_usage_snapshots as snap
    where snap.account_id = acct.id
      and coalesce(
        snap.raw_rate_limits ->> 'planType',
        snap.raw_rate_limits_by_limit_id -> 'codex' ->> 'planType'
      ) = acct.plan_type
  ),
  acct.created_at
)
where acct.plan_started_at is null
  and acct.plan_type is not null;
