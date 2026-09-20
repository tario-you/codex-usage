#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runBrowserAgent } from './lib/browser-sessions.js'

const configPath = process.argv[2] ?? path.join(os.homedir(), '.codex/codex-usage-sync.json')
try {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  await runBrowserAgent(config)
} catch {
  console.error('Browser helper could not start. Check Chrome installation and dashboard pairing.')
  process.exitCode = 1
}
