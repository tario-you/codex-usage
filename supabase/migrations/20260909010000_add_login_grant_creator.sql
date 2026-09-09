-- A dashboard viewer (someone who accepted an invite) can create a pool login
-- command on the inviter's pool. The grant still belongs to the pool owner,
-- who sees and can revoke it; created_by_user_id records who asked for it so
-- the viewer can see and revoke their own commands too.

alter table public.codex_login_grants
  add column if not exists created_by_user_id uuid
    references auth.users(id) on delete set null;

update public.codex_login_grants
set created_by_user_id = owner_user_id
where created_by_user_id is null;

create index if not exists codex_login_grants_created_by_idx
  on public.codex_login_grants (created_by_user_id, created_at desc);
