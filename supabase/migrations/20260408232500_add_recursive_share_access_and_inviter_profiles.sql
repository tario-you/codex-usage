create or replace function public.user_can_access_codex_owner(
  candidate_owner_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive visible_users(user_id) as (
    select auth.uid()
    union
    select share.owner_user_id
    from public.codex_dashboard_shares as share
    join visible_users
      on visible_users.user_id = share.viewer_user_id
    where share.revoked_at is null
  )
  select exists (
    select 1
    from visible_users
    where visible_users.user_id = candidate_owner_user_id
  );
$$;

create or replace function public.list_dashboard_inviters()
returns table (
  sharer_user_id uuid,
  sharer_email text,
  sharer_display_name text,
  sharer_avatar_url text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    share.owner_user_id as sharer_user_id,
    users.email as sharer_email,
    coalesce(
      nullif(users.raw_user_meta_data->>'full_name', ''),
      nullif(users.raw_user_meta_data->>'name', ''),
      users.email
    ) as sharer_display_name,
    coalesce(
      nullif(users.raw_user_meta_data->>'avatar_url', ''),
      nullif(users.raw_user_meta_data->>'picture', '')
    ) as sharer_avatar_url,
    share.created_at
  from public.codex_dashboard_shares as share
  join auth.users as users
    on users.id = share.owner_user_id
  where share.viewer_user_id = auth.uid()
    and share.revoked_at is null
  order by share.created_at asc;
$$;

grant execute on function public.list_dashboard_inviters() to authenticated;
