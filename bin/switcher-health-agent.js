#!/usr/bin/env node
// Report switcher metadata only. This worker never opens saved Codex sessions.
// Claude plans ride the same pass, read-only: claude-auto-switch alone renews
// those logins, so this worker reads their usage and never refreshes a token.
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reportExpiredSignIns, syncAllOnce, resolveStorePath } from './lib/sync-all.js'
import { repairProviders } from './lib/repair-claude.js'
import { syncClaudeOnce } from './lib/claude-logins.js'
import { followSystemProxy } from './lib/system-proxy.js'
const configPath = process.argv[2] ?? path.join(os.homedir(), '.codex/codex-usage-sync.json')
const interval = 60_000
const deviceFor = config => ({ codexHome: config.codexHome, label: config.label ?? os.hostname(), machineName: os.hostname(), metadata: { arch: process.arch, node: process.version, platform: process.platform } })
// Why a pass failed, never what it carried: a network code or an error name.
const why = error => error?.cause?.code ?? error?.code ?? error?.name ?? 'unknown'
for (;;) {
  await followSystemProxy()
  let config = null
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
    const result = await syncAllOnce({ config, storePath: resolveStorePath(), switcherOwned: true })
    console.log('Published ' + result.synced + ' login health rows.')
    await reportExpiredSignIns({ config, expired: result.expired ?? [], providers: repairProviders() })
      .catch(error => console.error('Expired sign-in report did not send (' + why(error) + ').'))
  } catch (error) {
    console.error('Connection health sync did not finish (' + why(error) + '); retrying in one minute.')
  }
  if (config) {
    try {
      const claude = await syncClaudeOnce({ config, device: deviceFor(config), refresh: false })
      console.log('Published ' + claude.synced + ' of ' + claude.total + ' Claude usage rows.')
      for (const row of claude.results.filter(r => !r.ok)) console.error('Claude ' + (row.source ?? 'login') + ': ' + row.reason)
    } catch (error) {
      console.error('Claude usage sync did not finish (' + why(error) + '); retrying in one minute.')
    }
  }
  await new Promise(resolve => setTimeout(resolve, interval))
}
