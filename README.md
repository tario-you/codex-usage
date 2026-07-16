# Codex Usage

Track Codex rate-limit balances and reset times across multiple accounts, then
see which account to use next.

- Dashboard: <https://codexusage.vercel.app>
- npm package: `codex-usage-dashboard`
- Detailed operations guide: [pairing, reset tracking, and releases](./docs/pairing-reset-tracking-and-release-runbook.md)

![Codex Usage dashboard](./public/codexusage.png)

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
   npx codex-usage-dashboard@latest pair "https://codexusage.vercel.app/api/pair/complete?token=..."
   ```

4. Keep the dashboard updated when needed:

   ```bash
   npx codex-usage-dashboard@latest sync --watch
   ```

The CLI stores the paired-device configuration in
`~/.codex/codex-usage-sync.json` by default.

### Start without a website account

```bash
npx codex-usage-dashboard@latest connect --site "https://codexusage.vercel.app"
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

If pairing still reports a native Codex `ENOENT`, test through a clean npm
cache:

```bash
npm_config_cache="$(mktemp -d)" npx --yes codex-usage-dashboard@latest pair "PAIRING_URL"
```

Then confirm the installed Codex CLI works:

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
