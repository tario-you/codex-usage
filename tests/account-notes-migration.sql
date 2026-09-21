-- Run only against an empty disposable PostgreSQL database with psql -v ON_ERROR_STOP=1.
create schema auth;
create role anon;
create role authenticated;
create table auth.users (id uuid primary key);
create table public.codex_accounts (owner_user_id uuid, email text, account_key text);
create function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
\ir ../supabase/migrations/20260909230000_add_account_notes.sql

insert into auth.users values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
insert into public.codex_accounts values
  ('11111111-1111-4111-8111-111111111111', 'BOTH@example.com', 'codex-one'),
  ('11111111-1111-4111-8111-111111111111', 'both@example.com', 'claude:both@example.com'),
  ('11111111-1111-4111-8111-111111111111', 'claude@example.com', 'claude:claude@example.com'),
  ('11111111-1111-4111-8111-111111111111', 'codex@example.com', 'codex-only');
insert into public.codex_account_notes (owner_user_id, email, ciphertext)
select '11111111-1111-4111-8111-111111111111', email, 'preserve-' || email
from unnest(array['both@example.com', 'claude@example.com', 'codex@example.com', 'orphan@example.com']) email;
insert into public.codex_account_notes (owner_user_id, email, ciphertext)
values ('22222222-2222-4222-8222-222222222222', 'both@example.com', 'other-owner');

\ir ../supabase/migrations/20260921200000_scope_account_notes_by_provider.sql

do $$
begin
  assert (select count(*) = 6 from public.codex_account_notes), 'preserve all rows, duplicate only the shared provider row';
  assert (select count(*) = 2 from public.codex_account_notes where provider = 'claude'), 'Claude-only and dual-provider notes migrate';
  assert (select bool_and(aad_version = 1) from public.codex_account_notes), 'legacy ciphertext keeps its binding version';
  assert (select count(*) = 2 from public.codex_account_notes where ciphertext = 'preserve-both@example.com'), 'shared ciphertext is copied unchanged';
  assert (select provider = 'claude' from public.codex_account_notes where email = 'claude@example.com'), 'Claude-only note stays with Claude';
  assert (select provider = 'codex' from public.codex_account_notes where email = 'orphan@example.com'), 'orphan note is retained';
  assert (select provider = 'codex' from public.codex_account_notes where ciphertext = 'other-owner'), 'other owners do not inherit this owner provider mapping';
  assert (select relrowsecurity from pg_class where oid = 'public.codex_account_notes'::regclass), 'RLS remains enabled';
  assert not has_table_privilege('authenticated', 'public.codex_account_notes', 'SELECT'), 'authenticated cannot read ciphertext';
  assert not has_table_privilege('anon', 'public.codex_account_notes', 'SELECT'), 'anon cannot read ciphertext';
end; $$;

insert into public.codex_account_notes (owner_user_id, provider, email, ciphertext)
values ('11111111-1111-4111-8111-111111111111', 'claude', 'both@example.com', 'edited-claude')
on conflict (owner_user_id, provider, email) do update set ciphertext = excluded.ciphertext, aad_version = excluded.aad_version;
delete from public.codex_account_notes
where owner_user_id = '11111111-1111-4111-8111-111111111111' and provider = 'codex' and email = 'both@example.com';
do $$
begin
  assert (select ciphertext = 'edited-claude' and aad_version = 2 from public.codex_account_notes where provider = 'claude' and email = 'both@example.com'), 'Codex deletion preserves the Claude edit';
  assert (select ciphertext = 'other-owner' from public.codex_account_notes where owner_user_id = '22222222-2222-4222-8222-222222222222'), 'other owner survives edits and deletion';
end; $$;
