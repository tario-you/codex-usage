-- Shared Codex logins: an owner publishes the encrypted ~/.codex/auth.json for
-- one of their accounts, then hands out single-use claim links. A recipient's
-- `use` command installs the login locally and keeps it in sync.
--
-- Token material is only ever stored encrypted (AES-256-GCM under the server's
-- CODEX_LOGIN_ENCRYPTION_KEY). Both tables are service-role only: RLS is on,
-- no policies exist, and anon/authenticated privileges are revoked, so the
-- browser can never read ciphertext or token hashes directly. The dashboard
-- reads share status through /api/login/shares.

create table if not exists public.codex_login_secrets (
  account_id uuid primary key references public.codex_accounts(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.codex_devices(id) on delete set null,
  account_email text not null,
  plan_type text,
  auth_mode text not null default 'chatgpt',
  ciphertext text not null,
  key_version integer not null default 1,
  fingerprint text not null,
  token_issued_at timestamptz not null,
  token_expires_at timestamptz,
  published_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists codex_login_secrets_owner_idx
  on public.codex_login_secrets (owner_user_id, published_at desc);

create table if not exists public.codex_login_grants (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.codex_accounts(id) on delete cascade,
  label text,
  claim_token_hash text not null unique,
  claim_token_preview text not null,
  access_token_hash text unique,
  status text not null default 'pending' check (
    status in ('pending', 'active', 'revoked', 'expired')
  ),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  claimed_machine_name text,
  claimed_label text,
  last_synced_at timestamptz,
  last_pushed_at timestamptz,
  sync_count integer not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists codex_login_grants_owner_created_idx
  on public.codex_login_grants (owner_user_id, created_at desc);

create index if not exists codex_login_grants_account_idx
  on public.codex_login_grants (account_id, status);

create trigger set_codex_login_secrets_updated_at
before update on public.codex_login_secrets
for each row
execute function public.touch_updated_at();

create trigger set_codex_login_grants_updated_at
before update on public.codex_login_grants
for each row
execute function public.touch_updated_at();

alter table public.codex_login_secrets enable row level security;
alter table public.codex_login_grants enable row level security;

revoke all on table public.codex_login_secrets from anon, authenticated;
revoke all on table public.codex_login_grants from anon, authenticated;
