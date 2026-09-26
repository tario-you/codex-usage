-- Unlinking one account used to revoke the whole machine that reported it, and
-- a machine running `sync --all` reports every plan, so one unlink stopped them
-- all (2026-09-21, 2026-09-25). An unlink is now remembered per owner: syncs
-- skip the account until the owner links it again.
create table public.codex_unlinked_accounts (
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  account_key text not null,
  unlinked_at timestamptz not null default now(),
  primary key (owner_user_id, account_key)
);
alter table public.codex_unlinked_accounts enable row level security;
revoke all on public.codex_unlinked_accounts from anon, authenticated;
grant all on public.codex_unlinked_accounts to service_role;
