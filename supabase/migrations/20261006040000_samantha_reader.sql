-- Samantha for Mac shows this dashboard on her own page (her-team#5389, #5390). The owner allows it once, on
-- the dashboard; the grant's one-time code becomes a reader token that only her server holds. The token reads
-- exactly what the dashboard reads (the codex_dashboard_accounts view and the weighted weekly history), as the
-- owner, and can change nothing: no sync, no switch, no sign-in, no notes.
create table public.codex_readers (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  return_origin text not null,
  code_hash text unique,
  code_expires_at timestamptz,
  token_hash text unique,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_read_at timestamptz,
  revoked_at timestamptz
);
create index codex_readers_owner_idx on public.codex_readers (owner_user_id);
alter table public.codex_readers enable row level security;
revoke all on public.codex_readers from anon, authenticated;
grant all on public.codex_readers to service_role;

-- The dashboard's own read path, as the owner: auth.uid() reads these claims, so the view's access_scope and
-- user_can_access_codex_owner answer for the owner exactly as they do in the owner's browser. Local to the
-- calling transaction (PostgREST runs each RPC in its own).
create or replace function public.reader_claims(reader_owner uuid)
returns void
language plpgsql
volatile
set search_path = public
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', reader_owner::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', reader_owner::text, true);
end;
$$;

create or replace function public.reader_dashboard_accounts(reader_owner uuid)
returns setof public.codex_dashboard_accounts
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public.reader_claims(reader_owner);
  return query
    select dash.*
    from public.codex_dashboard_accounts as dash
    where public.user_can_access_codex_owner(dash.owner_user_id);
end;
$$;

create or replace function public.reader_weighted_weekly_usage_history(
  reader_owner uuid,
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
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public.reader_claims(reader_owner);
  return query
    select history.*
    from public.list_dashboard_weighted_weekly_usage_history(range_start, usage_provider, bucket_seconds) as history;
end;
$$;

revoke all on function public.reader_claims(uuid) from public, anon, authenticated;
revoke all on function public.reader_dashboard_accounts(uuid) from public, anon, authenticated;
revoke all on function public.reader_weighted_weekly_usage_history(uuid, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.reader_dashboard_accounts(uuid) to service_role;
grant execute on function public.reader_weighted_weekly_usage_history(uuid, timestamptz, text, integer) to service_role;
