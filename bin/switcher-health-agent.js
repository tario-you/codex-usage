#!/usr/bin/env node
// Report switcher metadata only. This worker never opens saved Codex sessions.
// Claude plans ride the same pass, read-only: claude-auto-switch alone renews
// those logins, so this worker reads their usage and never refreshes a token.
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncAllOnce, resolveStorePath } from './lib/sync-all.js'
import { syncClaudeOnce } from './lib/claude-logins.js'
const configPath = process.argv[2] ?? path.join(os.homedir(), '.codex/codex-usage-sync.json')
const interval = 60_000
const deviceFor = config => ({ codexHome: config.codexHome, label: config.label ?? os.hostname(), machineName: os.hostname(), metadata: { arch: process.arch, node: process.version, platform: process.platform } })
for (;;) {
  let config = null
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
    const result = await syncAllOnce({ config, storePath: resolveStorePath(), switcherOwned: true })
    console.log('Published ' + result.synced + ' login health rows.')
  } catch {
    console.error('Connection health sync did not finish; retrying in one minute.')
  }
  if (config) {
    try {
      const claude = await syncClaudeOnce({ config, device: deviceFor(config), refresh: false })
      console.log('Published ' + claude.synced + ' of ' + claude.total + ' Claude usage rows.')
      for (const row of claude.results.filter(r => !r.ok)) console.error('Claude ' + (row.source ?? 'login') + ': ' + row.reason)
    } catch {
      console.error('Claude usage sync did not finish; retrying in one minute.')
    }
  }
  await new Promise(resolve => setTimeout(resolve, interval))
}
