alter table public.codex_browser_launches
  add column login_method text not null default 'email'
  check (login_method in ('email', 'google'));
