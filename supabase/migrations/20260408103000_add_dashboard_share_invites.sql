create table if not exists public.codex_dashboard_share_invites (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  invite_token_hash text not null unique,
  invite_token_preview text not null,
  status text not null default 'pending' check (
    status in ('pending', 'accepted', 'revoked', 'expired')
  ),
  expires_at timestamptz not null,
  accepted_by_user_id uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists codex_dashboard_share_invites_owner_created_idx
  on public.codex_dashboard_share_invites (owner_user_id, created_at desc);

create table if not exists public.codex_dashboard_shares (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  viewer_user_id uuid not null references auth.users(id) on delete cascade,
  invite_id uuid references public.codex_dashboard_share_invites(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint codex_dashboard_shares_owner_user_id_viewer_user_id_key
    unique (owner_user_id, viewer_user_id),
  constraint codex_dashboard_shares_no_self_share
    check (owner_user_id <> viewer_user_id)
);

create index if not exists codex_dashboard_shares_active_lookup_idx
  on public.codex_dashboard_shares (owner_user_id, viewer_user_id)
  where revoked_at is null;

create trigger set_codex_dashboard_share_invites_updated_at
before update on public.codex_dashboard_share_invites
for each row
execute function public.touch_updated_at();

create trigger set_codex_dashboard_shares_updated_at
before update on public.codex_dashboard_shares
for each row
execute function public.touch_updated_at();

alter table public.codex_dashboard_share_invites enable row level security;
alter table public.codex_dashboard_shares enable row level security;

create or replace function public.user_can_access_codex_owner(
  candidate_owner_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    candidate_owner_user_id = auth.uid()
    or exists (
      select 1
      from public.codex_dashboard_shares as share
      where share.owner_user_id = candidate_owner_user_id
        and share.viewer_user_id = auth.uid()
        and share.revoked_at is null
    );
$$;

grant execute on function public.user_can_access_codex_owner(uuid) to authenticated;

create policy "owners read dashboard share invites"
on public.codex_dashboard_share_invites
for select
to authenticated
using (owner_user_id = auth.uid());

create policy "owners insert dashboard share invites"
on public.codex_dashboard_share_invites
for insert
to authenticated
with check (owner_user_id = auth.uid());

create policy "owners update dashboard share invites"
on public.codex_dashboard_share_invites
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

create policy "owners and viewers read dashboard shares"
on public.codex_dashboard_shares
for select
to authenticated
using (
  owner_user_id = auth.uid()
  or viewer_user_id = auth.uid()
);

create policy "owners insert dashboard shares"
on public.codex_dashboard_shares
for insert
to authenticated
with check (owner_user_id = auth.uid());

create policy "owners update dashboard shares"
on public.codex_dashboard_shares
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "owners read codex accounts" on public.codex_accounts;

create policy "owners and viewers read codex accounts"
on public.codex_accounts
for select
to authenticated
using (public.user_can_access_codex_owner(owner_user_id));

drop policy if exists "owners read codex usage snapshots" on public.codex_usage_snapshots;

create policy "owners and viewers read codex usage snapshots"
on public.codex_usage_snapshots
for select
to authenticated
using (
  exists (
    select 1
    from public.codex_accounts as acct
    where acct.id = codex_usage_snapshots.account_id
      and public.user_can_access_codex_owner(acct.owner_user_id)
  )
);

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
