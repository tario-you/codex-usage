# Codex Usage

Track Codex rate-limit balances and reset times across multiple accounts, then
see which account to use next.

- Dashboard: <https://codexusage.vercel.app>
- npm package: `codex-usage-dashboard`
- Detailed operations guide: [pairing, reset tracking, and releases](./docs/pairing-reset-tracking-and-release-runbook.md)

![Codex Usage dashboard with account planning, reset history, and sign-in repair controls](./public/codexusage.png)

_Current dashboard with anonymized example data._

> The CLI runs with `npx codex-usage-dashboard@latest <command>`, nothing to install. A machine that cannot reach npm can use the pinned GitHub release instead: `npx --yes "github:tario-you/codex-usage#v0.3.0" <command>`.

## What it does

- Collects the rate-limit windows reported by the local Codex CLI.
- Displays the real duration of each available window, including weekly-only
  accounts.
- Plans account order from usable balance and upcoming reset times.
- Projects which reset will make an exhausted account usable again.
- Tracks historical weekly capacity across linked accounts.

## First time here?

Codex usage shows how much of every Codex plan is left, plans which account to
use next, and switches machines to the next plan automatically. There are three
things you can do, and each one has its own command. Pick the one you mean.

| You want to | Do this | What runs on the other machine |
|---|---|---|
| See your own usage in the dashboard | Sign in, choose **Add a machine**, run the command on the machine where you use Codex | `pair` (reports usage only) |
| See every account you own from one machine | Pair once, then `login setup` and `sync --all --watch` | `login setup`, `sync --all` |
| Let a friend use your plans, switching when one runs out | Find **Share Codex login**, choose **Create login command**, send it to them | `use` (signs their Codex into your plan) |
| Let a friend look at your dashboard | Choose **Invite a viewer**, send the link | nothing; they sign in with Google |

The common mistake: sending a friend the **Add a machine** command. That only
adds their usage to your dashboard. It never signs them into your plans. For
that they need the login command from **Share Codex login**.

### 1. See your own usage

1. Open <https://codexusage.vercel.app> and sign in with Google.
2. Choose **Add a machine** in the header. A command appears.
3. Paste the command into Terminal on the machine where you use Codex. It
   looks like this and runs once:

   ```bash
   npx codex-usage-dashboard@latest pair "https://codexusage.vercel.app/api/pair/complete?token=..."
   ```

4. Your plans show up in the dashboard within a minute. For live updates keep
   this running on that machine:

   ```bash
   npx codex-usage-dashboard@latest sync --watch
   ```

The command expires, so create a fresh one when it fails. The CLI keeps its
settings in `~/.codex/codex-usage-sync.json`. No browser account yet? Run
`npx codex-usage-dashboard@latest connect --site "https://codexusage.vercel.app"`
on the machine instead; it links the machine and opens your dashboard.

### 1b. Every account you own, from one machine

You do not need to remember which accounts you have. The machine does:

```bash
npx codex-usage-dashboard@latest login setup
```

It lists every Codex account this machine has ever used (the current login,
earlier logins Codex left behind, the Switchboard store, its switch records,
and whatever the dashboard already saw), checks which sign-ins still work, then
walks you through the rest one at a time: "Sign in as a@example.com now", a
browser tab opens, you sign in, next. Press Enter to skip one, `q` to stop.
It ends with one sync, so the dashboard shows all of them. Then keep this
running:

```bash
npx codex-usage-dashboard@latest sync --all --watch
```

`sync --all` reads every saved account's usage straight from ChatGPT, refreshes
an expired token on the way, includes the account this machine is signed into,
and reports all of them under this machine's pairing. `--watch` repeats every
five minutes (`--every 120` for two). The logins are kept in
`~/.codex-switcher/accounts.json` (mode 600, the same store the Codex
Switchboard uses). `login discover` prints the list without signing anything
in, `login add` adds one account by hand, `login list` shows what is saved, and
`login remove --email you@example.com` forgets one. The machine still has to
be paired once (section 1) so the dashboard knows whose accounts these are.

**Claude plans too.** The same `sync --all` pass reports every Claude login
this machine holds: the Claude Code sign-in (macOS Keychain, or
`~/.claude/.credentials.json` elsewhere), every login saved by
`claude-auto-switch` in `~/.claude-switcher/accounts.json`, and the Claude
desktop app's live login while it is running. They appear in the Plans table
with a Claude badge; the 5-hour and weekly windows land in the same Usable
columns. Nothing to sign in separately: sign in to Claude Code once and the
next pass picks it up. `--skip-claude` leaves them out.

### 1c. Expired sign-ins fix themselves from the dashboard

A saved sign-in stops refreshing every so often (OpenAI refuses the refresh
with a 401). The sync agent reports those accounts, the dashboard marks their
rows "sign-in expired" and shows **Fix sign-ins** under the Plans title. One
click asks the machine that holds the accounts to open one browser sign-in per
account; you sign in there and nothing else. Accounts the machine has used but
never signed in through the dashboard show up in the same line, with
**Sign them in**. The same thing from the terminal:

```bash
npx codex-usage-dashboard@latest login repair
```

### 1d. Switch your Codex to another plan with one click

Once the sync agent on a machine reports which login its Codex is on, that
row in Plans shows **active** and every other Codex row shows **Use**. One
click asks that machine to switch; its agent hands the request to the local
Codex Switchboard (the menu-bar service that owns the desktop app's login),
which makes the switch the same guarded way the menu bar does: never while a
task is running, never without a saved sign-in for that account. The row
shows "switching…" until the machine reports back, then flips to **active**;
a refusal (for example "Codex has active tasks") shows next to the button.
The agent polls every 15 seconds, so a switch lands within about half a
minute. A click nobody picks up within three minutes is dropped, never
replayed later. Machines that only sync a store (no Codex desktop) never
report an active login and are never switched.

### 2. Let a friend use your plans

On your side, once:

1. Add the machine that holds your logins (section 1) and keep
   `sync --watch` running there.
2. Publish your plans from that machine:

   ```bash
   npx codex-usage-dashboard@latest publish-login --all
   ```

3. In the dashboard, find **Share Codex login** and choose
   **Create login command**. Send the command to your friend. It is single
   use and expires after 24 hours.

On their side:

1. Paste the command into Terminal and add `--watch` so it keeps switching:

   ```bash
   npx codex-usage-dashboard@latest use "https://codexusage.vercel.app/api/login/claim?token=..." --watch
   ```

2. Restart the Codex app, or start a new `codex` session. Codex is now on
   your plan.
3. Leave that Terminal window open. When the plan runs out, the watcher moves
   them to your next usable plan and prints `Switched to ...`. Their own login
   is backed up; `npx codex-usage-dashboard@latest use --restore` brings it
   back.

The full owner and recipient details are under [Share a Codex login](#share-a-codex-login).

### 3. Let a friend look

Choose **Invite a viewer**, send the link. They sign in with Google and see
your plans read-only. From there they can also create their own login command
on your plans, and you see and can revoke every command they create.

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
npm_config_cache="$(mktemp -d)" npx codex-usage-dashboard@latest pair "PAIRING_URL"
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

1. Add the machine that holds the logins (see [First time here?](#first-time-here)) and keep
   `npx codex-usage-dashboard@latest sync --watch` running there.
2. Publish your plans:

   ```bash
   npx codex-usage-dashboard@latest publish-login --all
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
   `npx codex-usage-dashboard@latest unpublish-login --email you@example.com`.

### Recipient

```bash
npx codex-usage-dashboard@latest use "https://codexusage.vercel.app/api/login/claim?token=..."
```

This backs up the current `~/.codex/auth.json` to
`auth.json.before-shared-login`, installs the shared login, and writes
`~/.codex/codex-usage-shared-login.json`. Restart the Codex app or start a new
`codex` session afterwards.

Keep the login current while it is in use:

```bash
npx codex-usage-dashboard@latest use --watch
```

The watcher reports the plan's real rate limits to the dashboard once a
minute, pulls token refreshes, and, for a pool login, installs the next usable
plan when the current one is exhausted. It prints `Switched to ...` when that
happens; restart the Codex app if it is open.

Switch back to your own login at any time:

```bash
npx codex-usage-dashboard@latest use --restore
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

## Account notes

Passwords and reset notes live in the Plans table itself: each of your own
accounts has ChatGPT and Google columns (hidden behind an eye icon) and a Note
column, with a pencil to edit them inline. Emails that have a note but no
synced plan appear as "note only" rows at the bottom, and the plus in the table
header adds one. Notes are encrypted at rest with the shared-login key, decrypted
only for your own session, and never returned to people you invite.


### Open an account on the web

Click an owned account's email to bring its dedicated Chrome profile window to the front on your paired Mac. Use the Google / Email selector beside each email to choose its sign-in method; the choice is remembered per account on this dashboard browser. Accounts with a saved Google credential default to Google (you can override it). ChatGPT opens Google sign-in directly with the email hint when Google is selected, or its email sign-in flow otherwise. Claude opens its prefilled login page; choose Continue with Google there for Google accounts. Finish the provider's password, Google/Apple, or verification step if prompted. Later clicks reuse the same profile and saved sign-in. This does not convert CLI tokens into website cookies or change your everyday Chrome profile.

The Mac needs Google Chrome and the browser helper from a checkout containing this feature:

```sh
node scripts/install-browser-helper.mjs --apply
```

The installer uses the existing dashboard pairing in `~/.codex/codex-usage-sync.json` and runs a separate launchd helper. Existing sync agents keep running. Alternatively, run `codex-usage browser-agent` with an updated CLI. If multiple browser helpers are online, the dashboard asks which machine should open the session. Each account uses a separate `Codex Usage <hash>` profile under `~/Library/Application Support/Google/Chrome`. Chrome opens these profile windows in its normal application instance, preserving the existing Chrome identity guard. Saved sign-ins stay on this Mac; no passwords or browser cookies are uploaded. Requests expire after 90 seconds and are claimed once before launching.

Notes and saved passwords are scoped to **owner + provider + email**. Codex and
Claude can use the same email while keeping edits, deletion, and password reveal
independent. Choose a provider when adding a note without a synced plan.

Apply `20260921200000_scope_account_notes_by_provider.sql` before deploying the
provider-aware API and dashboard. Existing shared content is copied to both
providers when both plans exist; Claude-only content stays with Claude and
unsynced notes stay with Codex. Existing ciphertext remains readable, and the
next edit binds its encryption to the provider too. Old dashboard tabs must
reload before saving notes (writes now require a provider).

### Local task companion

The task companion runs beside Codex Usage at `http://127.0.0.1:3212`. Its
status, task IDs, and Claude prompt observations stay on this Mac; they are not
uploaded to the hosted usage dashboard. The dashboard's **Task companion** link
opens that local page after you install the helper.

With an existing, user-owned Codex shell launcher under `~/.local/bin`:

```bash
node bin/codex-usage.js companion install --launcher /absolute/path/to/your/codex-launcher
```

The macOS installer saves the launcher and Claude settings before-state, copies
an immutable companion runtime, wraps that launcher, adds observation hooks to
`~/.claude/settings.json`, and starts a login LaunchAgent for the local page.
It preserves existing permissions and hooks. It never closes or restarts Codex;
**recovery attaches on the next launch through that launcher**. Already-running
connections and old failed tasks are not taken over. A switcher reinstall that
replaces the launcher can detach the companion; the local page reports that no
connection is attached. Custom `CLAUDE_CONFIG_DIR` profiles need their own hook
configuration and are not modified by this installer.

On the original live app-server connection, a failed turn with a structured
connection or server error schedules a retry after 30 seconds, then 2 minutes,
then 5 minutes. There are at most three attempts per task per rolling hour.
Before each retry it checks the latest turn and live state; durable attempt
records prevent duplicate retries across connections and restarts. User stops,
active tasks, input requests, quota/authentication errors, safety stops, and
unknown failures do not qualify. A fresh continuation asks Codex to inspect the
current state before repeating work. No model, account, permission, or sandbox
overrides are sent. This is best-effort recovery after a reported failure; it
cannot guarantee exactly-once execution of an external action that failed after
that action took effect. Process crashes or silent hangs do not trigger retries.

Claude's observation hooks return no permission decision. The local page shows
sessions that reported a permission request, clearing an alert when that session
continues or after 24 hours. Approvals are still handled in Claude. Observation
starts when Claude loads the updated hooks; it does not scan existing prompts.
See [Claude's permission modes](https://code.claude.com/docs/en/permission-modes#actions-no-mode-auto-approves)
for the actions that still require input in bypass mode.

To run a protocol client through the wrapper directly:

```bash
node bin/companion.js wrap -- /absolute/path/to/codex app-server
node bin/companion.js serve
```

Pause automatic retries on the local page. To remove the integration:

```bash
node bin/codex-usage.js companion uninstall
```

Removal restores the exact original launcher only if the installed wrapper is
still unchanged, removes only the companion's hook commands, and keeps the
before-state copies. Existing Codex connections are left running. Tests:
`npm run test:companion`. The protocol follows the documented
[Codex app-server lifecycle and error events](https://developers.openai.com/codex/app-server/).
