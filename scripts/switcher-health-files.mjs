// The hosted uploader (com.tarioyou.codex-usage-sync-all) as installed on his Mac: the files its release copies, and
// the tests that cover them. install-switcher-health-sync.mjs copies these; update-switcher-health-sync.mjs installs a
// new master only when one of them changed and these tests pass.
export const UPLOADER_LABEL = 'com.tarioyou.codex-usage-sync-all'

export const AGENT_FILES = [
  'bin/switcher-health-agent.js',
  'bin/lib/sync-all.js',
  'bin/lib/login-file.js',
  'bin/lib/reset-credits.js',
  'bin/lib/plan-order.js',
  'bin/lib/dashboard-request.js',
  'bin/lib/claude-logins.js',
  'bin/lib/system-proxy.js',
  'bin/lib/repair-claude.js',
]

export const AGENT_TESTS = [
  'tests/agent-update.test.js',
  'tests/claude-logins.test.js',
  'tests/repair-claude.test.js',
  'tests/repair.test.ts',
  'tests/reset-credits.test.js',
  'tests/shared-login.test.js',
  'tests/sync-all.test.js',
  'tests/system-proxy.test.js',
  'tests/wake.test.js',
]
