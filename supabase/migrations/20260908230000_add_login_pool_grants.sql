-- Pool login grants: one login command that follows every login the owner
-- publishes. The recipient's watcher asks the dashboard which account to be
-- on, and the dashboard answers from the same usage snapshots and reset plan
-- the Accounts table uses. A pool grant has no fixed account_id; it tracks the
-- account the recipient is currently on in current_account_id.

alter table public.codex_login_grants
  alter column account_id drop not null;

alter table public.codex_login_grants
  add column if not exists scope text not null default 'account'
    check (scope in ('account', 'pool')),
  add column if not exists current_account_id uuid
    references public.codex_accounts(id) on delete set null,
  add column if not exists switched_at timestamptz,
  add column if not exists switch_count integer not null default 0;

alter table public.codex_login_grants
  drop constraint if exists codex_login_grants_scope_account_check;

alter table public.codex_login_grants
  add constraint codex_login_grants_scope_account_check
  check (scope = 'pool' or account_id is not null);

update public.codex_login_grants
set current_account_id = account_id
where current_account_id is null
  and account_id is not null;

create index if not exists codex_login_grants_current_account_idx
  on public.codex_login_grants (current_account_id, status);
