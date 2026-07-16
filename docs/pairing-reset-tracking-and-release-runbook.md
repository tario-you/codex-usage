# Pairing, Reset Tracking, and Release Runbook

Date: 2026-07-15

Status: pairing resolver fixed in `0.1.6`; automatic private-runtime recovery
added in `0.1.8`; weekly-only normalization and history fix deployed to
production

## Scope

This document covers three connected operational areas:

1. Pairing a local Codex installation with the hosted dashboard.
2. Interpreting normal two-window and special weekly-only rate limits.
3. Publishing and verifying the npm CLI without losing an interactive npm
   authentication session.

The canonical hosted dashboard is <https://codexusage.vercel.app>.

## User flows

### Pair a local machine with a signed-in dashboard

1. Sign in at <https://codexusage.vercel.app>.
2. Select **Create pairing command**.
3. Run the generated command before its token expires:

   ```bash
   npx codex-usage-dashboard@latest pair "https://codexusage.vercel.app/api/pair/complete?token=..."
   ```

4. The CLI starts `codex app-server`, reads the current account and its rate
   limits, completes the one-time pairing request, and writes device
   configuration to `~/.codex/codex-usage-sync.json`.
5. Run a one-time sync or keep a watcher alive:

   ```bash
   npx codex-usage-dashboard@latest sync
   npx codex-usage-dashboard@latest sync --watch
   ```

Pairing tokens expire. Always generate a fresh command instead of repeatedly
retrying an old URL.

### Connect without signing in first

```bash
npx codex-usage-dashboard@latest connect --site "https://codexusage.vercel.app"
```

This creates or reopens a device-linked dashboard flow. The hosted URL must be
the canonical project hostname above.

## Rate-limit data contract

Codex reports up to two windows for a limit:

| Field | Meaning |
| --- | --- |
| `usedPercent` | Percentage already consumed |
| `windowDurationMins` | Window duration and the source of its user-facing label |
| `resetsAt` | Absolute reset time |

The dashboard computes remaining balance as:

```text
remaining = clamp(100 - usedPercent, 0, 100)
```

If `usedPercent`, `windowDurationMins`, and `resetsAt` are all absent, the
window is absent. It must not be displayed, planned against, or converted into
100% remaining.

### Known duration labels

| Duration | Label |
| --- | --- |
| `300` minutes | 5-hour |
| `10080` minutes | Weekly |
| Other whole hours | `<hours>h` |
| Other durations | `<minutes>m` |

The primary/secondary position is not the semantic label. Duration is.

### Weekly-only event mode

During the special weekly-only Codex mode observed in July 2026, current
snapshots had this shape:

```text
primary.windowDurationMins = 10080
primary.usedPercent = <weekly usage>
secondary = null
```

That means the account has one Weekly limit. The old positional UI incorrectly
showed the primary value under **5-hour** and converted the absent secondary
value into 100% under **Weekly**.

The correction has three layers:

1. Client normalization derives windows dynamically from the fields that
   actually exist.
2. The database view leaves remaining balance null when usage is null.
3. Weekly history selects the window whose duration is 10,080 minutes, whether
   it appears in the primary or secondary position.

Historical snapshots can therefore move between the classic two-window schema
and weekly-only schema without corrupting the chart.

## Reset-plan behavior

For each account:

1. Collect only present windows.
2. Compute usable balance as the lowest known remaining balance across those
   windows.
3. Exclude accounts with no known positive usable balance from **Use now**.
4. Order usable accounts by nearest future reset, then by higher usable
   balance, then by account label.
5. Simulate each upcoming reset by restoring only that window to 100%.
6. When every account is exhausted, select the first reset that changes an
   account from 0% usable to a positive usable balance.

This prevents a 5-hour reset from being advertised as useful when an exhausted
Weekly window would still keep the account unusable.

## Pairing failure: native Codex `ENOENT`

### Symptom

The published `0.1.5` command could fail with an error shaped like:

```text
spawn .../node_modules/@openai/codex-darwin-arm64/vendor/.../codex ENOENT
```

It then incorrectly concluded that the bundled Codex did not support
`codex app-server`.

### Root cause

The temporary environment created by `npx` prepended its own
`node_modules/.bin` directory to `PATH`. Its `codex` shim resolved to the same
bundled `@openai/codex` launcher whose expected native executable was missing.

The earlier fallback from the bundled launcher to the bare command `codex`
therefore looped back to the same broken shim. A healthy global Codex at a
later path such as `/opt/homebrew/bin/codex` was never reached.

### Fix in `0.1.6`

The resolver now:

1. Enumerates concrete Codex executables from `PATH`.
2. Resolves symlinks and skips a path that points back to the bundled launcher.
3. Deduplicates equivalent executables.
4. Probes each candidate for `app-server` support.
5. Uses the bundled dependency only as a final verified fallback.
6. Reports diagnostics for every failed candidate if none work.

### Automatic recovery in `0.1.8`

If every installed, previously repaired, and bundled candidate fails its
`app-server` probe, the CLI now repairs itself before returning an error:

1. Creates `~/.codex/codex-usage-runtime` by default.
2. Uses a new temporary npm cache instead of the potentially corrupted cache
   that produced the original failure.
3. Installs `@openai/codex@latest` with optional platform packages explicitly
   included.
4. Deletes the temporary npm cache after installation.
5. Probes the repaired launcher for `app-server` support.
6. Reuses the private runtime on later pairing and sync commands.

This does not modify the global Codex installation and does not require
`sudo`. The network install runs only after every local candidate fails.

Configuration:

| Environment variable | Behavior |
| --- | --- |
| `CODEX_USAGE_RUNTIME_DIR` | Overrides the private runtime location |
| `CODEX_USAGE_DISABLE_AUTO_REPAIR=1` | Disables the automatic network repair |

If the private repair also fails, the final diagnostic preserves every failed
candidate and the repair error before recommending a manual global install.

### Troubleshooting checklist

Confirm the public release:

```bash
npm view codex-usage-dashboard@latest version --prefer-online
```

Confirm the installed Codex CLI:

```bash
command -v codex
codex --version
codex app-server --help
```

Use a clean npm cache to distinguish a stale `npx` installation from a current
release:

```bash
npm_config_cache="$(mktemp -d)" npx --yes codex-usage-dashboard@latest pair "PAIRING_URL"
```

Interpret the boundary correctly:

- Native `ENOENT` before any HTTP request means executable resolution failed.
- `fetch failed` against an intentionally unreachable test URL proves Codex
  started and the CLI reached the HTTP pairing boundary.
- A pairing-token error from the hosted API means executable resolution worked
  but the token is invalid or expired.

## npm release runbook

### Preconditions

- The intended pull request is merged.
- Automated checks pass.
- `npm whoami` returns the package maintainer.
- `package.json` contains a version that is not already published.

### Validate

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run release:check
```

`release:check` verifies that the tarball contains `README.md`, `package.json`,
and every declared CLI entry. It also rejects a version already present in the
registry.

### Publish with WebAuthn or Touch ID

Run this from a real interactive terminal:

```bash
npm publish
```

If npm prints an authentication URL:

1. Do not cancel or close the waiting `npm publish` process.
2. Open the exact URL printed by that process.
3. Approve with the configured security key or Mac Touch ID.
4. Return to the same terminal and wait for:

   ```text
   + codex-usage-dashboard@<version>
   ```

An **Authentication Successful** browser page is not proof of publication by
itself. If the matching CLI process was canceled, npm has nothing left to
complete. Start a fresh `npm publish` and authenticate its new URL.

### Verify registry propagation

Avoid a stale cached registry response:

```bash
npm view codex-usage-dashboard@latest version --prefer-online
npm view codex-usage-dashboard dist-tags --json --prefer-online
```

Then test the public artifact through a clean npm cache:

```bash
npm_config_cache="$(mktemp -d)" \
  npx --yes codex-usage-dashboard@latest pair \
  "http://127.0.0.1:9/api/pair/complete?token=public-release-check"
```

Expected result:

```text
fetch failed
```

That failure is deliberate. It proves the public package resolved a working
Codex CLI, started `app-server`, read the local account, and reached the HTTP
boundary without creating a real pairing.

## July 2026 verification record

The `0.1.6` release was verified at these boundaries:

- npm `latest` resolved to `0.1.6` with `--prefer-online`.
- A clean-cache public `npx` run reached the intentionally unreachable pairing
  endpoint and returned `fetch failed`, not native `ENOENT`.
- The production dashboard showed weekly-only accounts with one Weekly window.
- Classic accounts still showed both 5-hour and Weekly windows.
- Weekly history corrected the latest aggregate from a phantom 338% to 210%
  remaining across four tracked accounts.
- Desktop and mobile layouts were visually inspected in production.

## Relevant implementation

- [`bin/codex-usage.js`](../bin/codex-usage.js)
- [`bin/lib/codex-runtime.js`](../bin/lib/codex-runtime.js)
- [`src/shared/rate-limit-windows.ts`](../src/shared/rate-limit-windows.ts)
- [`src/features/dashboard/reset-plan.ts`](../src/features/dashboard/reset-plan.ts)
- [`src/features/dashboard/dashboard-page.tsx`](../src/features/dashboard/dashboard-page.tsx)
- [`supabase/migrations/20260716093000_fix_weekly_only_rate_limits.sql`](../supabase/migrations/20260716093000_fix_weekly_only_rate_limits.sql)
- [`tests/codex-resolver.test.js`](../tests/codex-resolver.test.js)
- [`tests/reset-plan.test.ts`](../tests/reset-plan.test.ts)
