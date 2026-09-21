begin;

alter table public.codex_account_notes
  add column provider text not null default 'codex' check (provider in ('codex', 'claude')),
  add column aad_version integer not null default 1 check (aad_version in (1, 2)),
  drop constraint codex_account_notes_owner_user_id_email_key,
  add constraint codex_account_notes_owner_provider_email_key unique (owner_user_id, provider, email);

-- Keep Claude-only notes with Claude. Orphan notes remain with Codex, the
-- original provider. Never decrypt, discard, or rewrite existing ciphertext.
update public.codex_account_notes n
set provider = 'claude'
where exists (
  select 1 from public.codex_accounts a
  where a.owner_user_id = n.owner_user_id and lower(trim(a.email)) = n.email
    and a.account_key like 'claude:%'
) and not exists (
  select 1 from public.codex_accounts a
  where a.owner_user_id = n.owner_user_id and lower(trim(a.email)) = n.email
    and a.account_key not like 'claude:%'
);

-- Both providers previously displayed the same note. Preserve that initial
-- content in independent rows; subsequent edits and deletions affect only one.
insert into public.codex_account_notes
  (owner_user_id, provider, email, ciphertext, key_version, aad_version, created_at, updated_at)
select n.owner_user_id, 'claude', n.email, n.ciphertext, n.key_version, n.aad_version, n.created_at, n.updated_at
from public.codex_account_notes n
where n.provider = 'codex' and exists (
  select 1 from public.codex_accounts a
  where a.owner_user_id = n.owner_user_id and lower(trim(a.email)) = n.email
    and a.account_key like 'claude:%'
);

-- New writes must identify a provider and bind encryption to it. Migrated
-- version-1 ciphertext stays readable until its next normal edit.
alter table public.codex_account_notes
  alter column provider drop default,
  alter column aad_version set default 2;

commit;
