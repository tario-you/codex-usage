# Codex Usage

Track Codex rate-limit balances and reset times across multiple accounts, then
see which account to use next.

- Dashboard: <https://codexusage.vercel.app>
- npm package: `codex-usage-dashboard`
- Detailed operations guide: [pairing, reset tracking, and releases](./docs/pairing-reset-tracking-and-release-runbook.md)

![Codex Usage dashboard](./public/codexusage.png)

> The generated commands install the pinned GitHub release `v0.3.0` because npm still carries 0.1.8, which has no `use` or `publish-login`. Publishing to npm needs the maintainer's own `npm login`; once npm carries 0.3.0 or newer, `CLI_INSTALL_SPEC` in `src/shared/cli.ts` and the two `NPX_COMMAND` constants under `bin/` go back to `codex-usage-dashboard@latest`.

## What it does

- Collects the rate-limit windows reported by the local Codex CLI.
- Displays the real duration of each available window, including weekly-only
  accounts.
- Plans account order from usable balance and upcoming reset times.
- Projects which reset will make an exhausted account usable again.
- Tracks historical weekly capacity across linked accounts.

## Connect a machine

### Pair with an existing dashboard account

1. Open <https://codexusage.vercel.app> and sign in.
2. Select **Create pairing command**.
3. Run the generated command before its token expires:

   ```bash
   npx --yes "github:tario-you/codex-usage#v0.3.0" pair "https://codexusage.vercel.app/api/pair/complete?token=..."
   ```

4. Keep the dashboard updated when needed:

   ```bash
   npx --yes "github:tario-you/codex-usage#v0.3.0" sync --watch
   ```

The CLI stores the paired-device configuration in
`~/.codex/codex-usage-sync.json` by default.

### Start without a website account

```bash
npx --yes "github:tario-you/codex-usage#v0.3.0" connect --site "https://codexusage.vercel.app"
```

## Weekly-only Codex limits

Do not assume the first window is always 5-hour and the second window is
always Weekly. Codex can return one primary window with a duration of 10,080
minutes and no secondary window. That is one Weekly limit, not a 5-hour limit
plus a missing Weekly limit.

The dashboard identifies windows by `windowDurationMins` and ignores absent
windows. A null or `N/A` secondary window must never become a fake 100%
balance.

## Pairing troubleshooting

Check the public version first:

```bash
npm view codex-usage-dashboard@latest version --prefer-online
```

Version `0.1.6` and newer skip a broken Codex shim injected by an `npx`
environment and probe installed Codex executables for `app-server` support.
Version `0.1.8` and newer also self-repair when every installed and bundled
candidate is broken: the CLI installs a fresh private Codex runtime under
`~/.codex/codex-usage-runtime` using an isolated npm cache, verifies
`app-server`, and reuses that runtime on later runs.

Set `CODEX_USAGE_RUNTIME_DIR` to move the private runtime. Set
`CODEX_USAGE_DISABLE_AUTO_REPAIR=1` to opt out of automatic network repair.

If pairing still reports a native Codex `ENOENT`, test through a clean npm
cache:

```bash
npm_config_cache="$(mktemp -d)" npx --yes "github:tario-you/codex-usage#v0.3.0" pair "PAIRING_URL"
```

If automatic repair also fails, confirm the installed Codex CLI works:

```bash
command -v codex
codex --version
codex app-server --help
```

Generate a fresh pairing command if the old token expired.

## Development

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

## Release

On the release branch, bump the version without creating a local tag and run
the checks:

```bash
npm version patch --no-git-tag-version
npm test
npm run typecheck
npm run lint
npm run build
npm run release:check
```

Commit and merge that version bump. From the merged checkout, publish in an
interactive terminal:

```bash
npm publish
```

If npm prints an authentication URL, leave `npm publish` running, open that
URL, and approve with the configured security key or Touch ID. Authentication
against a canceled publish process does not publish the package.

Verify the registry without a stale local response:

```bash
npm view codex-usage-dashboard@latest version --prefer-online
```

## Incident documentation

- [Pairing, weekly-only reset tracking, and npm release runbook](./docs/pairing-reset-tracking-and-release-runbook.md)
- [OAuth and invite host regression](./docs/oauth-invite-host-regression-2026-04-08.md)

## Share a Codex login

Let someone run their local Codex CLI or Codex app on your ChatGPT plans. The
dashboard stores each login encrypted, hands out single-use login commands,
keeps every copy on the newest token generation, and moves recipients to your
next usable plan when the one they are on runs out.

### Owner

1. Pair the machine that holds the logins (see above) and keep
   `npx --yes "github:tario-you/codex-usage#v0.3.0" sync --watch` running there.
2. Publish your plans:

   ```bash
   npx --yes "github:tario-you/codex-usage#v0.3.0" publish-login --all
   ```

   `--all` publishes every account in the Codex switcher store
   (`~/.codex-switcher/accounts.json`). Without `--all`, `publish-login`
   publishes the account Codex is logged into on this machine;
   `--email you@example.com` publishes one store account; and
   `--auth-file /path/to/auth.json` uses any other source.
3. Open <https://codexusage.vercel.app>, find **Share Codex login**, and select
   **Create login command**. That command follows every published plan: the
   recipient starts on the plan the reset plan recommends and switches when it
   hits zero. Each plan row also offers a **Pinned command** that never
   switches. Commands are single use and expire after 24 hours.
4. Anyone who accepted your **Invite a viewer** link sees your pool under
   **Shared with you** and can get their own auto-switching login command
   there, without asking you. You see every command they create and can
   revoke it.
5. **Revoke** a person or **Stop sharing** a plan from the same card.
   Stopping also works from the terminal with
   `npx --yes "github:tario-you/codex-usage#v0.3.0" unpublish-login --email you@example.com`.

### Recipient

```bash
npx --yes "github:tario-you/codex-usage#v0.3.0" use "https://codexusage.vercel.app/api/login/claim?token=..."
```

This backs up the current `~/.codex/auth.json` to
`auth.json.before-shared-login`, installs the shared login, and writes
`~/.codex/codex-usage-shared-login.json`. Restart the Codex app or start a new
`codex` session afterwards.

Keep the login current while it is in use:

```bash
npx --yes "github:tario-you/codex-usage#v0.3.0" use --watch
```

The watcher reports the plan's real rate limits to the dashboard once a
minute, pulls token refreshes, and, for a pool login, installs the next usable
plan when the current one is exhausted. It prints `Switched to ...` when that
happens; restart the Codex app if it is open.

Switch back to your own login at any time:

```bash
npx --yes "github:tario-you/codex-usage#v0.3.0" use --restore
```

### How refreshes stay consistent

Codex refreshes ChatGPT tokens after eight days, and OpenAI rotates refresh
tokens with reuse detection. Every copy therefore syncs through the dashboard:
the owner's `sync --watch` and each recipient's `use --watch` compare token
generations once a minute, and the newest generation, ordered by the access
token's issue time, wins in both directions. A recipient's copy carries
`last_refresh` shifted one day forward so the owner's machine performs the
usual refresh. Details and the recovery steps are in
[docs/shared-codex-login.md](./docs/shared-codex-login.md).
