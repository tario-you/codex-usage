# OAuth + Invite Host Regression

Date: 2026-04-08

Status: fixed in code, fixed in hosted Supabase config, deployed to production

## Summary

Two user-visible failures were coupled:

1. Clicking `Continue with Google` on the hosted dashboard returned to `https://codex-use-age-tario-yous-projects.vercel.app/#` instead of `https://codexusage.vercel.app/`.
2. Invite links appeared to do nothing. New invite rows were created, but invite acceptance never created any rows in `codex_dashboard_shares`, so invitees saw zero inherited accounts.

The real bug was not in the share-recursion SQL. The break happened earlier in the flow: Supabase OAuth redirect handling and host selection.

## Audited Sources

Official docs:

- Supabase Redirect URLs docs: <https://supabase.com/docs/guides/auth/redirect-urls>
- Supabase troubleshooting note for wrong `redirectTo` behavior: <https://supabase.com/docs/guides/troubleshooting/why-am-i-being-redirected-to-the-wrong-url-when-using-auth-redirectto-option-_vqIeO>
- MDN `sessionStorage` docs: <https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage>
- Vercel Projects overview: <https://docs.vercel.com/docs/projects>

Repo and production evidence:

- [src/features/dashboard/dashboard-page.tsx](/Users/tarioyou/codex-usage/src/features/dashboard/dashboard-page.tsx)
- [src/shared/site.ts](/Users/tarioyou/codex-usage/src/shared/site.ts)
- [scripts/setup-hosted.ts](/Users/tarioyou/codex-usage/scripts/setup-hosted.ts)
- [api/shares/start.ts](/Users/tarioyou/codex-usage/api/shares/start.ts)
- [api/shares/accept.ts](/Users/tarioyou/codex-usage/api/shares/accept.ts)
- Vercel project `prj_L99BYyV8e92hqOJrn5yDaAT32L5h` audited on 2026-04-08 via MCP:
  `domains = [codexdash.vercel.app, codexusage.vercel.app, a-ten-brown.vercel.app, codexmonitor.vercel.app, codexdashboard.vercel.app, codex-use-age-tario-yous-projects.vercel.app, codex-use-age-git-master-tario-yous-projects.vercel.app]`
- Production deployment audited on 2026-04-08:
  `dpl_Dvwy7NetpRxN1nZQCk8c67fCX6na`
- Hosted Supabase config push audited on 2026-04-08:
  remote `site_url` changed from `https://codex-use-age-tario-yous-projects.vercel.app` to `https://codexusage.vercel.app`
- Hosted database audit on 2026-04-08:
  recent `codex_dashboard_share_invites` rows existed, while `codex_dashboard_shares` was empty

## What We Observed

### Symptom 1

Google sign-in from the hosted app returned users to:

`https://codex-use-age-tario-yous-projects.vercel.app/#`

instead of:

`https://codexusage.vercel.app/`

### Symptom 2

Invite creation still worked, but invite redemption did not. A production audit showed:

- `codex_dashboard_share_invites`: multiple fresh `pending` rows for owner `59c24773-6fea-49a4-afb7-c312f229ce57`
- `codex_dashboard_shares`: zero rows

That distinction mattered. It proved:

- token generation worked
- share recursion was irrelevant to the immediate break
- the accept path was never completing

### Production evidence that narrowed it down

- Runtime logs showed repeated `POST /api/shares/start -> 200`
- Runtime logs did not show successful `POST /api/shares/accept` calls during the broken flow
- The hosted Supabase config still had `site_url = "https://codex-use-age-tario-yous-projects.vercel.app"`

## Root Cause

The hosted dashboard was sending Supabase:

- `redirectTo = window.location.href`

That included full path and query state, including invite tokens such as:

- `https://codexusage.vercel.app/?invite=...`
- `https://codex-use-age-tario-yous-projects.vercel.app/?invite=...`

Per Supabase docs, the URL in `redirectTo` must match the configured Redirect URLs allow-list, and the `Site URL` is used as the default redirect target when `redirectTo` is not used successfully or not provided.

In this project, hosted config only allow-listed the bare origins:

- `https://codexusage.vercel.app`
- `https://codex-use-age-tario-yous-projects.vercel.app`

It did not allow-list exact full URLs with query-bearing callback shapes. The production `site_url` was also still set to the project-owned hostname.

So the broken chain was:

1. App asked Supabase to return to the full current URL.
2. That URL did not exactly match the configured redirect list.
3. Supabase fell back to the configured `site_url`.
4. The browser landed on `https://codex-use-age-tario-yous-projects.vercel.app/#`.
5. The invite token was gone.
6. `/api/shares/accept` never ran.
7. `codex_dashboard_shares` stayed empty.

There was a second-order effect too: browser storage is origin-scoped. MDN documents that `sessionStorage` is bound to the current origin and tab. That means any cross-host hop between `codexusage.vercel.app` and `codex-use-age-tario-yous-projects.vercel.app` can silently lose host-local browser state unless it is deliberately re-established.

## Why Previous Fixes Did Not Actually Fix It

### `68d2f0c` (`fix: keep shared invites on the project host`)

This changed invite screens to force users onto the project-owned hostname.

Why it felt plausible:

- it reduced host-splitting by pushing invitees onto one host

Why it was still wrong:

- it made the wrong host canonical
- it treated the symptom, not the redirect contract
- it still left OAuth dependent on `window.location.href`
- it encoded the fallback hostname instead of fixing Supabase redirect configuration

### `e50e5d2` (`fix: keep invite links on the active dashboard host`)

This switched invite generation back to the current host and added `codexusage.vercel.app` to hosted additional redirect URLs.

Why it was insufficient:

- `site_url` still pointed at `https://codex-use-age-tario-yous-projects.vercel.app`
- OAuth still used `window.location.href`
- invite URLs could still carry query-bearing callback URLs that were not explicitly configured

So the project still had a mismatch between:

- the callback URL the browser asked for
- the exact URLs Supabase was prepared to honor

### `87649d6` (`fix: redeem invite links for Google sessions reliably`)

This improved Google session detection and invite auto-accept behavior.

Why it did not solve the incident:

- the accept handler logic was not the active failure point
- there were no share rows because the accept route was never being reached
- better Google-session detection cannot fix a dropped invite token

## What Actually Worked

### 1. Introduce one canonical hosted origin

[src/shared/site.ts](/Users/tarioyou/codex-usage/src/shared/site.ts) now defines:

- hosted canonical origin: `https://codexusage.vercel.app`
- localhost remains local in development

### 2. Stop using `window.location.href` as hosted OAuth `redirectTo`

[src/features/dashboard/dashboard-page.tsx](/Users/tarioyou/codex-usage/src/features/dashboard/dashboard-page.tsx#L280) now sends Supabase to a clean callback target:

- `redirectTo = https://codexusage.vercel.app/`

This matches the hosted contract and avoids query-bearing callback drift.

### 3. Preserve invite state across OAuth outside the callback URL

[src/features/dashboard/dashboard-page.tsx](/Users/tarioyou/codex-usage/src/features/dashboard/dashboard-page.tsx#L1591) now:

- stores the pending invite token in `sessionStorage`
- restores it after Supabase returns from OAuth
- clears it once acceptance succeeds or the user signs out

This decouples:

- auth callback location
- invite redemption state

### 4. Redirect hosted invite screens to the canonical host before login

[src/features/dashboard/dashboard-page.tsx](/Users/tarioyou/codex-usage/src/features/dashboard/dashboard-page.tsx#L180) redirects invite links opened on alternate hosted aliases to `codexusage.vercel.app` before allowing the Google CTA.

### 5. Make server-generated hosted links use the canonical origin

These now generate hosted URLs against the canonical origin instead of the request origin:

- [api/connect/start.ts](/Users/tarioyou/codex-usage/api/connect/start.ts#L31)
- [api/connect/open.ts](/Users/tarioyou/codex-usage/api/connect/open.ts#L15)
- [api/pair/start.ts](/Users/tarioyou/codex-usage/api/pair/start.ts#L10)
- [api/shares/start.ts](/Users/tarioyou/codex-usage/api/shares/start.ts#L9)

### 6. Fix hosted Supabase defaults so setup does not re-break production later

[scripts/setup-hosted.ts](/Users/tarioyou/codex-usage/scripts/setup-hosted.ts#L18) now makes:

- `https://codexusage.vercel.app` the default hosted `site_url`
- `https://codex-use-age-tario-yous-projects.vercel.app` an additional fallback redirect URL

This was then pushed live with `npm run setup:hosted`.

## Deployment and Config Audit

Hosted config change applied on 2026-04-08:

- before: `site_url = "https://codex-use-age-tario-yous-projects.vercel.app"`
- after: `site_url = "https://codexusage.vercel.app"`

Production deployment after the fix:

- deployment id: `dpl_Dvwy7NetpRxN1nZQCk8c67fCX6na`
- production URL: `https://codex-use-6thbl9cg6-tario-yous-projects.vercel.app`
- aliases included:
  - `codexusage.vercel.app`
  - `codex-use-age-tario-yous-projects.vercel.app`

## Fast Triage Checklist For Next Time

When this class of bug happens again, do these checks in order:

1. Check the exact `redirectTo` being passed to Supabase.
2. Check hosted Supabase `site_url` and `additional_redirect_urls`.
3. Check whether the failing flow is losing query state before the app rehydrates.
4. Check runtime logs for both `/api/shares/start` and `/api/shares/accept`.
5. Query both tables:
   - `codex_dashboard_share_invites`
   - `codex_dashboard_shares`
6. If invites exist but shares do not, stop debugging recursion and focus on callback/state handoff.
7. Verify which Vercel domains are attached to the production deployment.

## Regression Rules

These are the rules that should prevent a repeat:

1. Never use `window.location.href` as hosted Supabase OAuth `redirectTo`.
2. Keep one explicit hosted canonical origin in [src/shared/site.ts](/Users/tarioyou/codex-usage/src/shared/site.ts).
3. Keep hosted Supabase `site_url` aligned with that same canonical origin in [scripts/setup-hosted.ts](/Users/tarioyou/codex-usage/scripts/setup-hosted.ts).
4. Treat invite tokens and other resume-state as app state, not callback URL configuration.
5. If a new hosted alias is introduced, add it as an additional redirect URL, not as the new default `site_url` unless product intent changed.
6. When changing invite logic, verify all three layers together:
   - browser callback URL
   - Supabase remote auth config
   - post-auth invite acceptance request
7. Do not assume “invite acceptance is broken” means SQL or RLS first. Confirm the accept endpoint is actually being hit.

## Recommended Future Hardening

These were not required for the fix, but they would make this class of bug cheaper next time:

- Add an integration check that asserts hosted auth uses `buildDashboardAuthReturnUrl(...)`, not `window.location.href`.
- Add a small production smoke test that:
  - opens `/?invite=test-token` on each attached hosted alias
  - verifies the app normalizes to `codexusage.vercel.app`
- Log invite-accept start and failure paths explicitly in `/api/shares/accept` so “route never hit” becomes obvious from logs.
- Add a doc review item to any auth/domain change:
  `Does this change alter the canonical hosted origin or Supabase redirect contract?`

## Short Version

We kept trying to fix invite redemption inside the app while the real break was outside the accept path:

- wrong hosted default origin
- wrong Supabase `site_url`
- wrong `redirectTo` shape

The durable fix was:

- one canonical hosted hostname
- one clean OAuth callback URL
- invite state stored separately from the callback URL
- hosted config updated so future setup runs do not regress production
