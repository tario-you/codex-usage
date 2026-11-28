#!/usr/bin/env node
// Installs the launchd job that keeps the dashboard sync on master (update-switcher-health-sync.mjs): its own clone of
// the repo, never his checkout, and a pass every minute. Run once with --apply; the job then updates itself too.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SOURCE_DIR, STATE_PATH } from './update-switcher-health-sync.mjs'

if (process.argv.slice(2).join(' ') !== '--apply') throw new Error('Use --apply')
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const label = 'com.tarioyou.codex-usage-agent-update'
const plist = path.join(os.homedir(), 'Library/LaunchAgents', label + '.plist')
const logPath = path.join(path.dirname(STATE_PATH), 'agent-update.log')

if (!existsSync(path.join(SOURCE_DIR, '.git'))) {
  mkdirSync(path.dirname(SOURCE_DIR), { recursive: true })
  run('git', ['clone', '--quiet', 'https://github.com/tario-you/codex-usage.git', SOURCE_DIR])
}
mkdirSync(path.dirname(STATE_PATH), { recursive: true })
// Homebrew's versioned Cellar path goes away when node upgrades; its opt/ link stays.
const cellar = process.execPath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/)
const node = cellar && existsSync(`${cellar[1]}/opt/${cellar[2]}/bin/node`) ? `${cellar[1]}/opt/${cellar[2]}/bin/node` : process.execPath
const job = {
  Label: label,
  ProgramArguments: [node, path.join(SOURCE_DIR, 'scripts/update-switcher-health-sync.mjs')],
  WorkingDirectory: SOURCE_DIR,
  StartInterval: 60,
  RunAtLoad: true,
  ProcessType: 'Background',
  LowPriorityIO: true,
  Nice: 10,
  StandardOutPath: logPath,
  StandardErrorPath: logPath,
}
const candidate = path.join(path.dirname(STATE_PATH), 'agent-update-plist.json')
writeFileSync(candidate, JSON.stringify(job))
run('/usr/bin/plutil', ['-convert', 'xml1', '-o', plist, candidate])
run('/usr/bin/plutil', ['-lint', plist])
const domain = 'gui/' + process.getuid()
try { run('/bin/launchctl', ['bootout', `${domain}/${label}`]) } catch { /* first install */ }
run('/bin/launchctl', ['bootstrap', domain, plist])
console.log(JSON.stringify({ installed: label, source: SOURCE_DIR, log: logPath }))
