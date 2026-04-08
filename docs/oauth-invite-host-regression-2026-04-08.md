# OAuth + Invite Host Regression

Date: 2026-04-08

Status: fixed in hosted Supabase config, fixed in code, follow-up query race fixed in code, universal-link follow-up fixed in code, deployed to production for the earlier host/race fixes

## Summary

Three user-visible failures were coupled across the same invite flow over time:

1. Clicking `Continue with Google` on the hosted dashboard returned to `https://codex-use-age-tario-yous-projects.vercel.app/#` instead of `https://codexusage.vercel.app/`.
2. Invite links appeared to do nothing. New invite rows were created, but invite acceptance never created any rows in `codex_dashboard_shares`, so invitees saw zero inherited accounts.
3. Even after those fixes, invite links were still single-claim. The first successful viewer effectively consumed the link, which is the opposite of a universal invite link.

The earlier break was not in the share-recursion SQL. It happened earlier in the flow: Supabase OAuth redirect handling and host selection. The later universal-link bug was different: it was encoded directly into the invite schema, the accept handler, and the dashboard copy.

## Audited Sources

Official docs:

- Supabase Redirect URLs docs: <https://supabase.com/docs/guides/auth/redirect-urls>
- Supabase troubleshooting note for wrong `redirectTo` behavior: <https://supabase.com/docs/guides/troubleshooting/why-am-i-being-redirected-to-the-wrong-url-when-using-auth-redirectto-option-_vqIeO>
- MDN `sessionStorage` docs: <https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage>
- TanStack Query guide for disabling and pausing queries: <https://tanstack.com/query/v5/docs/framework/react/guides/disabling-queries>
- TanStack Query `QueryClient` reference: <https://tanstack.com/query/v5/docs/reference/QueryClient>
- Vercel Projects overview: <https://docs.vercel.com/docs/projects>

Repo and production evidence:

- [src/features/dashboard/dashboard-page.tsx](/Users/tarioyou/codex-usage/src/features/dashboard/dashboard-page.tsx)
- [src/shared/site.ts](/Users/tarioyou/codex-usage/src/shared/site.ts)
- [scripts/setup-hosted.ts](/Users/tarioyou/codex-usage/scripts/setup-hosted.ts)
- [api/shares/start.ts](/Users/tarioyou/codex-usage/api/shares/start.ts)
- [api/shares/accept.ts](/Users/tarioyou/codex-usage/api/shares/accept.ts)
- [api/shares/preview.ts](/Users/tarioyou/codex-usage/api/shares/preview.ts)
- [supabase/migrations/20260408103000_add_dashboard_share_invites.sql](/Users/tarioyou/codex-usage/supabase/migrations/20260408103000_add_dashboard_share_invites.sql#L1)
- `git show b934153` audited on 2026-04-08: original invite launch encoded single-use semantics in schema, API, and UI
- `git show eee7d4f` audited on 2026-04-08: first-visit race fix was correct, but it intentionally left the single-claim invite state machine unchanged
- Current `HEAD` audit on 2026-04-08:
  - [api/shares/accept.ts](/Users/tarioyou/codex-usage/api/shares/accept.ts#L16) now keeps pending invites reusable and issues access per viewer via `codex_dashboard_shares`
  - [src/features/dashboard/dashboard-page.tsx](/Users/tarioyou/codex-usage/src/features/dashboard/dashboard-page.tsx#L972) now describes the link as reusable
- Vercel project `prj_L99BYyV8e92hqOJrn5yDaAT32L5h` audited on 2026-04-08 via MCP:
  `domains = [codexdash.vercel.app, codexusage.vercel.app, a-ten-brown.vercel.app, codexmonitor.vercel.app, codexdashboard.vercel.app, codex-use-age-tario-yous-projects.vercel.app, codex-use-age-git-master-tario-yous-projects.vercel.app]`
- Production deployment audited on 2026-04-08:
  `dpl_Dvwy7NetpRxN1nZQCk8c67fCX6na`
- Follow-up production deployment audited on 2026-04-08:
  `dpl_EwAR1XHywkMMdYTRwWTC2KCznvBz`
- Hosted Supabase config push audited on 2026-04-08:
  remote `site_url` changed from `https://codex-use-age-tario-yous-projects.vercel.app` to `https://codexusage.vercel.app`
- Hosted database audit on 2026-04-08:
  recent `codex_dashboard_share_invites` rows existed, while `codex_dashboard_shares` was empty
- Live browser network audits on 2026-04-08 via Chrome DevTools:
  - before the follow-up fix, dashboard reads could complete against pre-share state
  - after the follow-up fix, the first dashboard reads happened only after `/api/shares/accept` returned `200`

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

There were three distinct failures across the same invite flow over time:

1. Hosted OAuth could return to the wrong host and drop the invite token.
2. Even after that was fixed, dashboard queries could start before invite redemption had finished.
3. Even after both of those were fixed, the invite itself was still modeled as something one viewer could claim, not as a reusable capability multiple viewers could redeem.

## Root Cause, Layer 1: Hosted OAuth Redirect Contract

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

## Root Cause, Layer 2: Dashboard Queries Started Before Invite Redemption Finished

After the host fix, invite acceptance started reaching `/api/shares/accept` again. But the client still had a race:

1. Session hydration completed.
2. `useQuery(...)` for `codex_dashboard_accounts` and `list_dashboard_inviters` became enabled immediately.
3. Those reads could run before the invite had finished creating the `codex_dashboard_shares` row.
4. The page tried to recover by calling `accountsQuery.refetch()` and `invitersQuery.refetch()` after acceptance.
5. The UI also cleared invite state before the first post-accept dashboard snapshot was guaranteed to exist.

That meant invite redemption was no longer broken, but the dashboard could still render against pre-share data and only become correct after a later refetch, focus event, or another visit.

The audited network traces showed that difference directly.

Before the follow-up fix on production, one fresh invite trace showed:

- `POST /api/shares/accept -> 200`
- an earlier `GET codex_dashboard_accounts` completed with only the viewer's owned account
- an earlier `POST list_dashboard_inviters` completed with `[]`
- a later `GET codex_dashboard_accounts` completed with shared + owned rows
- a later `POST list_dashboard_inviters` completed with the inviter row

After the follow-up fix on production, a fresh invite trace showed:

- `POST /api/shares/accept -> 200`
- first `GET codex_dashboard_accounts` returned shared + owned rows
- first `POST list_dashboard_inviters` returned the inviter row

There was no pre-accept dashboard read anymore.

## Root Cause, Layer 3: Invite Rows Encoded Single-Claim State Instead Of Reusable Access

The original share migration in [supabase/migrations/20260408103000_add_dashboard_share_invites.sql](/Users/tarioyou/codex-usage/supabase/migrations/20260408103000_add_dashboard_share_invites.sql#L1) stored:

- invite `status`
- `accepted_by_user_id`
- `accepted_at`

That was a clue that the invite row itself was being treated as the thing that gets claimed.

The original acceptance flow introduced in `b934153` did exactly that:

- it updated the invite row from `pending` to `accepted`
- it wrote one `accepted_by_user_id`
- it rejected later viewers with `This invite link has already been claimed.`

The dashboard copy also matched that contract. Before this follow-up, the invite card explicitly said the link was single-use.

This is why the universal-link complaint survived the host fix and the query-race fix: those fixes made invite redemption reliable for the first viewer, but they did not change the underlying rule that the invite row dies after one successful claimant.

That rule was also unnecessary. Actual dashboard access is already enforced in [supabase/migrations/20260408103000_add_dashboard_share_invites.sql](/Users/tarioyou/codex-usage/supabase/migrations/20260408103000_add_dashboard_share_invites.sql#L19) by `codex_dashboard_shares`, which already has:

- one row per `(owner_user_id, viewer_user_id)`
- a uniqueness constraint on that pair
- `revoked_at` for turning access off later

So the correct per-viewer source of truth was already in the schema. We were just using the wrong table as the state machine.

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

### `f50c3b6` (`fix: stabilize hosted OAuth invites and document the regression`)

This fixed the real host/callback break and correctly documented it.

Why it still did not fully solve the user complaint:

- it restored invite acceptance, but it did not change when dashboard queries started
- `codex_dashboard_accounts` and `list_dashboard_inviters` were still allowed to run as soon as session hydration finished
- the app still relied on a later refetch to clean up any pre-accept reads
- the invite UI could still transition before the first post-accept dashboard data was definitely ready

So `f50c3b6` fixed the missing-token failure, but not the remaining sequencing race.

### Render-only follow-up experiment

A short follow-up patch kept the invite landing visible longer so users would not fall straight into the empty dashboard shell.

Why that was not enough on its own:

- it changed what the user saw
- it did not change when `useQuery(...)` began reading dashboard data
- it did not remove the pre-accept fetch window

That experiment was useful because it narrowed the problem to query sequencing, but it was not the durable fix.

### `eee7d4f` (`fix: load shared accounts on the first invite visit`)

This fixed the post-auth race correctly.

Why it still did not solve the universal-link complaint:

- it gated dashboard reads until invite redemption finished
- it did not change the invite state machine introduced in `b934153`
- `/api/shares/accept` still tried to turn one invite row into one accepted claimant
- the second distinct viewer was still blocked even though `codex_dashboard_shares` could safely hold both viewers
- the dashboard copy still described the link as single-use

So `eee7d4f` solved “first invite visit renders empty” and left “this link should work for multiple people” untouched.

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

### 7. Treat invite redemption as a barrier before loading dashboard data

[src/features/dashboard/dashboard-page.tsx](/Users/tarioyou/codex-usage/src/features/dashboard/dashboard-page.tsx) now keeps dashboard queries disabled while an invite token is still being resolved.

That means:

- session hydration alone no longer starts dashboard reads during invite acceptance
- the app accepts the invite first
- then it fetches fresh dashboard accounts and inviters explicitly
- then it seeds the React Query cache
- only after that does it clear the invite token and transition into the normal dashboard view

This removes the race instead of relying on background refetch timing.

### 8. Do not clear the retry path until post-accept dashboard data succeeds

The invite token is now cleared only after the fresh post-accept dashboard data has been loaded and cached.

Why this matters:

- if `/api/shares/accept` succeeds but the subsequent dashboard read fails, the user can still retry from the same invite state
- the app no longer throws away the only resume handle before the first successful shared-data load

### 9. Keep pending invite links reusable and move viewer state to `codex_dashboard_shares`

[api/shares/accept.ts](/Users/tarioyou/codex-usage/api/shares/accept.ts#L16) now treats invite acceptance as:

- validate the viewer session and Google identity
- reject only invalid, expired, or revoked links
- keep a live invite row in `pending`
- upsert one `codex_dashboard_shares` row for `(owner_user_id, viewer_user_id)`
- report `alreadyAccepted` based on that viewer's existing share row instead of the invite row

This is the part that actually makes the link universal. The invite token stays reusable until expiry or revocation, while access is still scoped per viewer.

### 10. Align the dashboard text with the actual contract

[src/features/dashboard/dashboard-page.tsx](/Users/tarioyou/codex-usage/src/features/dashboard/dashboard-page.tsx#L972) now says:

- `Invite viewers`
- `Create a reusable link. Anyone who opens it before it expires and signs in with Google gets access to your dashboard accounts.`

This matters because the old copy was not just misleading text. It was describing the exact backend contract we had accidentally kept.

## What Did Not Work In The Universal-Link Follow-Up

- Changing the UI copy alone would not have fixed anything. The restriction was server-side in `/api/shares/accept`.
- Reusing invite `status = 'accepted'` as “someone has used this link at least once” would still be wrong, because [api/shares/preview.ts](/Users/tarioyou/codex-usage/api/shares/preview.ts#L37) surfaces that status to the client and [src/features/dashboard/dashboard-page.tsx](/Users/tarioyou/codex-usage/src/features/dashboard/dashboard-page.tsx#L846) disables the Google CTA when status is `accepted`.
- Treating `accepted_by_user_id` as the access source of truth was the architectural mistake. Access belongs in `codex_dashboard_shares`, not on the invite token row.
- We did not backfill old already-accepted invite rows into reusable ones. Legacy links already marked `accepted` still behave as consumed links and should be regenerated.

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

Follow-up production deployment after the query-race fix:

- deployment id: `dpl_EwAR1XHywkMMdYTRwWTC2KCznvBz`
- production URL: `https://codex-use-mksljdhxq-tario-yous-projects.vercel.app`
- audited browser trace on 2026-04-08 showed:
  - `GET /?invite=...`
  - `GET /api/shares/preview?token=...`
  - `POST /api/shares/accept -> 200`
  - first `GET codex_dashboard_accounts` returned shared + owned rows
  - first `POST list_dashboard_inviters` returned the inviter row

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
7. If shares exist but the first dashboard render is still empty, inspect the network order for:
   - first dashboard reads
   - `/api/shares/accept`
   - first successful shared-data read
8. Verify which Vercel domains are attached to the production deployment.
9. Audit whether the invite token is modeled as a reusable capability or as a one-viewer claim.
10. If the product intent is “share one link with multiple people,” verify the same pending invite can be redeemed by two distinct viewer accounts before calling the fix complete.

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
8. Do not enable dashboard account queries while an invite token is still unresolved.
9. Do not clear the invite token, sessionStorage resume token, or invite-focused UI until the first post-accept dashboard read succeeds.
10. When a fix claims to solve invite acceptance, audit the actual network order. One successful later refetch does not prove the race is gone.
11. Do not use `accepted_by_user_id` on `codex_dashboard_share_invites` as the live source of truth for who currently has access.
12. Keep viewer access truth in `codex_dashboard_shares`, one row per `(owner_user_id, viewer_user_id)`.
13. If product intent is a universal invite link, do not transition the invite row into a terminal `accepted` state on first redemption.
14. When changing invite copy, audit the schema and the accept endpoint in the same change. Text and backend contract must agree.

## Recommended Future Hardening

These were not required for the fix, but they would make this class of bug cheaper next time:

- Add an integration check that asserts hosted auth uses `buildDashboardAuthReturnUrl(...)`, not `window.location.href`.
- Add a small production smoke test that:
  - opens `/?invite=test-token` on each attached hosted alias
  - verifies the app normalizes to `codexusage.vercel.app`
- Add an invite smoke test that asserts dashboard queries do not start until invite redemption has completed.
- Add an invite smoke test that redeems the same pending invite from two distinct viewer accounts and asserts two active `codex_dashboard_shares` rows.
- Log invite-accept start and failure paths explicitly in `/api/shares/accept` so “route never hit” becomes obvious from logs.
- Add a doc review item to any auth/domain change:
  `Does this change alter the canonical hosted origin or Supabase redirect contract?`
- Add a doc review item to any invite-flow change:
  `Can dashboard data load before the invite token has been redeemed and the first shared-data read has succeeded?`
- Add a second invite-flow doc review item:
  `Is the invite row acting as a reusable capability, or did we accidentally turn it back into a one-viewer claim?`

## Short Version

We had two different bugs in sequence.

First, we kept trying to fix invite redemption inside the app while the real break was outside the accept path:

- wrong hosted default origin
- wrong Supabase `site_url`
- wrong `redirectTo` shape

Then, after that was fixed, invite acceptance still had one more race:

- dashboard data could start loading too early
- the page could transition before the first shared-data read finished
- the app was relying on timing instead of a hard state barrier

The durable fix was:

- one canonical hosted hostname
- one clean OAuth callback URL
- invite state stored separately from the callback URL
- hosted config updated so future setup runs do not regress production
- dashboard queries disabled until invite resolution finishes
- explicit post-accept dashboard fetch and cache seed before the UI leaves the invite flow
- access moved back to the correct source of truth: one share row per viewer, while the invite token stays reusable until expiry
