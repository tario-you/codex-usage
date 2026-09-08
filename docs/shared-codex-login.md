# Shared Codex Logins

Date: 2026-09-08

Status: shipped in dashboard release `0.2.0`; hosted migration
`20260908210000_add_codex_login_sharing.sql` applied to the production Supabase
project.

## Scope

An owner lets another person run their local Codex CLI or Codex app on one of
the owner's ChatGPT plans. The dashboard holds the login encrypted, the owner
hands out single-use login commands, and every copy of the login stays on the
newest token generation. The owner can revoke a person or stop sharing an
account at any time.

## What a Codex login is

Codex stores a ChatGPT login in `~/.codex/auth.json`:

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "...",
    "access_token": "...",
    "refresh_token": "...",
    "account_id": "..."
  },
  "last_refresh": "2026-09-08T15:34:57.131692Z"
}
```

Measured on 2026-09-08 against the Codex CLI source
(`codex-rs/login/src/auth/manager.rs`):

| Fact | Value |
| --- | --- |
| Access token lifetime | 10 days (`exp - iat`) |
| Refresh trigger | access token within 5 minutes of expiry, or `last_refresh` older than 8 days |
| Refresh response | new id, access, and refresh tokens; the old refresh token is retired |
| Reuse of an old refresh token | `refresh_token_reused`, Codex asks for a new sign-in |
| Before refreshing | Codex reloads `auth.json` from disk and skips the refresh when the file changed |

Two machines holding the same generation would race for the eight-day refresh,
and the loser would lose its login. The design below exists to keep every
copy on one generation.

## Flows

### Owner: publish

```bash
npx codex-usage-dashboard@latest publish-login
npx codex-usage-dashboard@latest publish-login --email you@example.com
npx codex-usage-dashboard@latest publish-login --auth-file /path/to/auth.json
```

`publish-login` needs the machine's pairing config
(`~/.codex/codex-usage-sync.json`). The login source is resolved in this
order:

1. `--auth-file` reads that file.
2. `--store <accounts.json> --email <email>` reads one account from a Codex
   switcher store.
3. `--email <email>` alone uses the active `~/.codex/auth.json` when it is that
   account, otherwise the default switcher store at
   `~/.codex-switcher/accounts.json` (override with `CODEX_SWITCHER_STORE`).
4. No option uses the active `~/.codex/auth.json`, and also sends a usage
   snapshot through `codex app-server` so the dashboard row is current.

The CLI posts to `POST /api/login/publish` with the device token. The server
persists the snapshot when one was sent, creates the account row when the
dashboard has never seen that email, encrypts the login, and stores it in
`codex_login_secrets`. If the server already holds a newer generation, it
returns that copy and the CLI writes it back into the local source.

The published account is recorded in the pairing config under
`publishedLogins`, with its source and last known fingerprint.

### Owner: keep fresh

Every `sync` (and every tick of `sync --watch`) calls
`reconcilePublishedLogins`. For each published login it reads the local source,
computes the fingerprint, and calls `POST /api/login/sync` with the device
token. The local file is only attached when its fingerprint differs from the
last known one. Outcomes:

| Outcome | Meaning | CLI action |
| --- | --- | --- |
| `unchanged` | same generation on both sides | none |
| `stored` | the local generation was newer | log it |
| `pull` | the dashboard generation is newer | write it into the local source |
| HTTP 404 | the login was unpublished from the dashboard | drop the config entry |

Writing into a switcher store updates only that account's `auth_data` token
fields and keeps everything else. Writes use a temporary file, `rename`, and
mode `0600`.

### Owner: share and revoke

On the dashboard, **Share Codex login** lists every published account. **Create
login command** calls `POST /api/login/grants/start` and shows:

```bash
npx codex-usage-dashboard@latest use "https://codexusage.vercel.app/api/login/claim?token=..."
```

The claim token is single use and expires after 24 hours. Each active or
pending grant is listed with **Revoke** (`POST /api/login/grants/revoke`).
**Stop sharing** (`POST /api/login/unpublish`) deletes the ciphertext and
revokes every grant for that account. The same unpublish route accepts a
device token, which is what `unpublish-login` uses.

### Recipient: install

```bash
npx codex-usage-dashboard@latest use "<login-url>"
```

`use` posts the claim, then:

1. Copies the existing `~/.codex/auth.json` to `auth.json.before-shared-login`
   once. A later `use` never overwrites that backup.
2. Writes the shared login with `last_refresh` shifted 24 hours forward.
3. Writes `~/.codex/codex-usage-shared-login.json` with the grant access token,
   the sync URL, the account label, and the fingerprint.

The recipient restarts the Codex app or starts a new `codex` session.

### Recipient: keep fresh, restore

```bash
npx codex-usage-dashboard@latest use --watch
npx codex-usage-dashboard@latest use
npx codex-usage-dashboard@latest use --restore
```

Every tick reads the local `auth.json`:

- If it is no longer a ChatGPT login, or it belongs to a different email, the
  watcher stops and leaves the file alone.
- Otherwise it calls `POST /api/login/sync` with the access token, attaching
  the local file only when its fingerprint changed since the last sync.
- `pull` writes the newer generation (shifted `last_refresh`), `stored` means
  this machine refreshed first and the dashboard now carries its generation.
- HTTP 401 (revoked) or 410 (unpublished) restores the backup, removes the
  shared login config, and stops.

`--restore` does the same restore on demand.

## Why the newest generation wins by `iat`

Ordering uses the access token's `iat` claim, never `last_refresh`, because a
recipient's file carries a shifted `last_refresh`. Both `api/_lib/login-file.ts`
and `bin/lib/login-file.js` derive the identity (email, plan, account id,
issued at) from the access token claims with the id token as a fallback.

The fingerprint is `sha256(id_token \n access_token \n refresh_token \n
account_id)`, so a shifted `last_refresh` does not change it.

## Security model

- Token material is encrypted at rest with AES-256-GCM under
  `CODEX_LOGIN_ENCRYPTION_KEY` (32 bytes, base64). The account id is the
  associated data, so a ciphertext cannot be moved to another row. The key
  lives in the Vercel project environment (production, preview, development)
  and in `.env.collector.local` for local API development. Losing the key
  loses every published login; owners republish to recover.
- `codex_login_secrets` and `codex_login_grants` have RLS enabled with no
  policies, and `anon` and `authenticated` privileges are revoked. Only the
  service role used by the API routes can read them. The dashboard reads
  status through `GET /api/login/shares`.
- Claim tokens and access tokens are stored as SHA-256 hashes, like pairing
  and invite tokens.
- Publishing is authenticated by the paired device token. Dashboard actions
  are authenticated by the Supabase session.
- The API only accepts ChatGPT logins. API key logins are refused.
- The CLI never prints token values.

## Known boundaries

- Revoking stops updates immediately, and a cooperative recipient's watcher
  restores their own login on the next tick. A recipient that is not running
  the watcher keeps working until the tokens rotate, at most about ten days,
  because only OpenAI can invalidate a token.
- If both the owner's machine and a recipient are offline for more than eight
  days and then both refresh before syncing, one side gets
  `refresh_token_reused` and needs `codex login` again. Keeping `sync --watch`
  and `use --watch` running avoids this in practice.
- The Codex switcher store on the owner's machine is written by other tools
  (the switchboard service and `codex-usage-sync-all.mjs`). The CLI writes
  through a temporary file and `rename`, so a concurrent write loses at most
  one sixty-second tick.
- The owner's paired machine must run the `0.2.0` CLI or newer for the
  keep-fresh loop. Older watchers ignore `publishedLogins`.

## Verification record (2026-09-08)

Local dev server against the production Supabase project:

- `publish-login --email <owner>` from the switcher store: `Published Codex
  login for <owner> (pro).`
- `POST /api/login/grants/start`: single-use command returned.
- `use "<claim-url>" --codex-home /tmp/shared-login-recipient`: `auth.json`
  written with mode `0600`, tokens identical to the store entry, `last_refresh`
  24.00 hours after the access token `iat`.
- `CODEX_HOME=/tmp/shared-login-recipient codex login status`: `Logged in using
  ChatGPT`.
- `CODEX_HOME=/tmp/shared-login-recipient codex exec "Reply with exactly the
  word OK"`: `OK`, exit 0.
- `GET https://chatgpt.com/backend-api/wham/usage` with the shared access
  token: HTTP 200, plan `pro`.
- Revoke from the API, then `use`: the shared login was removed and the
  config deleted.
- Dashboard panel rendered at 1280x900 with the publication, an active grant,
  a pending command, and revoke.

## Relevant implementation

- [`api/_lib/login-file.ts`](../api/_lib/login-file.ts)
- [`api/_lib/login-crypto.ts`](../api/_lib/login-crypto.ts)
- [`api/_lib/login-reconcile.ts`](../api/_lib/login-reconcile.ts)
- [`api/_lib/login-store.ts`](../api/_lib/login-store.ts)
- [`api/login/`](../api/login/)
- [`bin/lib/login-file.js`](../bin/lib/login-file.js)
- [`bin/lib/shared-login.js`](../bin/lib/shared-login.js)
- [`src/features/dashboard/shared-login-panel.tsx`](../src/features/dashboard/shared-login-panel.tsx)
- [`supabase/migrations/20260908210000_add_codex_login_sharing.sql`](../supabase/migrations/20260908210000_add_codex_login_sharing.sql)
- [`tests/login-crypto.test.ts`](../tests/login-crypto.test.ts)
- [`tests/shared-login.test.js`](../tests/shared-login.test.js)
