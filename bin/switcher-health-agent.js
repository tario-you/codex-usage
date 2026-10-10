#!/usr/bin/env node
// Report switcher metadata only. This worker never opens saved Codex sessions.
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncAllOnce, resolveStorePath } from './lib/sync-all.js'
const configPath = process.argv[2] ?? path.join(os.homedir(), '.codex/codex-usage-sync.json')
const interval = 60_000
for (;;) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const result = await syncAllOnce({ config, storePath: resolveStorePath(), switcherOwned: true })
    console.log('Published ' + result.synced + ' login health rows.')
  } catch {
    console.error('Connection health sync did not finish; retrying in one minute.')
  }
  await new Promise(resolve => setTimeout(resolve, interval))
}
