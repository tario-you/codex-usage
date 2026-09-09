-- Account notes: an owner's private per-email notes (ChatGPT password, Google
-- password, free text) shown on their own dashboard behind an eye toggle.
-- Stored only as AES-256-GCM ciphertext under CODEX_LOGIN_ENCRYPTION_KEY,
-- bound to the owner and the email. Service-role only: RLS is on, no policies
-- exist, and anon/authenticated privileges are revoked. Never returned to
-- invited viewers; /api/login/notes serves the caller's own notes only.

create table if not exists public.codex_account_notes (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  ciphertext text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (owner_user_id, email)
);

create index if not exists codex_account_notes_owner_idx
  on public.codex_account_notes (owner_user_id, email);

create trigger set_codex_account_notes_updated_at
before update on public.codex_account_notes
for each row
execute function public.touch_updated_at();

alter table public.codex_account_notes enable row level security;
revoke all on table public.codex_account_notes from anon, authenticated;
