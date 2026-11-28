#!/usr/bin/env node
// 11-28, his words: "each time i switch a plan it gets this problem". The switch fix (#112) sat merged for three days
// while the dashboard sync on his Mac still ran #110, so every Claude switch greyed the new plan. This keeps that sync
// on master by itself: launchd runs it every minute from its own clone (never his checkout). When master changed one
// of the sync's files and the sync's tests pass there, it installs master with install-switcher-health-sync.mjs. A
// sync installed by hand from a commit master does not hold yet is left as it is. Installed by install-agent-updater.mjs.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { followSystemProxy } from '../bin/lib/system-proxy.js'
import { AGENT_FILES, AGENT_TESTS, UPLOADER_LABEL } from './switcher-health-files.mjs'

export const SOURCE_DIR = path.join(os.homedir(), '.local/share/codex-usage/source')
export const STATE_PATH = path.join(os.homedir(), '.local/state/codex-usage/agent-update.json')
const UPLOADER_PLIST = path.join(os.homedir(), 'Library/LaunchAgents', UPLOADER_LABEL + '.plist')

/** The commit the sync runs, from its launchd arguments (…/sync-agent/<commit>/bin/switcher-health-agent.js). */
export function installedRevision(programArguments) {
  if (!Array.isArray(programArguments)) return null
  for (const arg of programArguments) {
    const match = typeof arg === 'string' ? arg.match(/\/sync-agent\/([0-9a-f]{40})\/bin\/switcher-health-agent\.js$/) : null
    if (match) return match[1]
  }
  return null
}

/**
 * What one pass does with master's commit `target`: 'current' (the sync runs it); 'kept' (the sync runs a commit
 * master does not hold, installed by hand to try before its merge, or none this can read); 'unchanged' (no sync file
 * changed since); else 'install'.
 */
export function planUpdate({ installed, target, onMaster, agentChanged }) {
  if (installed === target) return 'current'
  if (!installed || !onMaster) return 'kept'
  if (agentChanged === false) return 'unchanged'
  return 'install'
}

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`)
const lastLine = (error) => String(error?.stderr || error?.message || error).trim().split('\n').at(-1)
const toolPath = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':')
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: toolPath }, ...options })
const git = (...args) => run('git', ['-C', SOURCE_DIR, ...args])
/** `git` exit 0 is yes, 1 is no; anything else (a commit this clone lacks) is null. */
const gitAnswer = (...args) => { try { git(...args); return true } catch (error) { return error?.status === 1 ? false : null } }
const readState = () => { try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch { return {} } }
const saveState = (state) => { mkdirSync(path.dirname(STATE_PATH), { recursive: true }); writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n') }

function ensureDependencies(state) {
  const lockHash = createHash('sha256').update(readFileSync(path.join(SOURCE_DIR, 'package-lock.json'))).digest('hex')
  if (state.lockHash === lockHash && existsSync(path.join(SOURCE_DIR, 'node_modules/.bin/tsx'))) return
  const npm = existsSync(path.join(path.dirname(process.execPath), 'npm')) ? path.join(path.dirname(process.execPath), 'npm') : 'npm'
  run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: SOURCE_DIR, timeout: 15 * 60_000 })
  state.lockHash = lockHash
}

async function main() {
  // launchd jobs do not take the Mac's VPN proxy; abroad, git and npm would never reach GitHub (system-proxy.js).
  if (await followSystemProxy()) return
  if (!existsSync(path.join(SOURCE_DIR, '.git'))) throw new Error(`no clone at ${SOURCE_DIR}; run scripts/install-agent-updater.mjs --apply`)
  if (!existsSync(UPLOADER_PLIST)) throw new Error('the paired dashboard sync is not installed')
  git('fetch', '--quiet', 'origin', 'master')
  const target = git('rev-parse', 'FETCH_HEAD').trim()
  // The clone follows master every pass, so this script's next run is master's too.
  if (git('rev-parse', 'HEAD').trim() !== target) git('checkout', '--quiet', '--detach', target)
  const installed = installedRevision(JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', UPLOADER_PLIST])).ProgramArguments)
  const onMaster = installed ? gitAnswer('merge-base', '--is-ancestor', installed, target) === true : false
  const agentChanged = onMaster ? gitAnswer('diff', '--quiet', installed, target, '--', ...AGENT_FILES) === false : null
  const step = planUpdate({ installed, target, onMaster, agentChanged })
  const state = { ...readState(), lastPass: { at: new Date().toISOString(), target, installed, step } }
  saveState(state)
  if (step !== 'install') return
  try {
    ensureDependencies(state)
    saveState(state)
  } catch (error) {
    log(`dependencies for ${target.slice(0, 7)} did not install, trying again next pass: ${lastLine(error)}`)
    return
  }
  try {
    run(path.join(SOURCE_DIR, 'node_modules/.bin/tsx'), ['--tsconfig', 'tsconfig.app.json', '--test', ...AGENT_TESTS], { cwd: SOURCE_DIR, timeout: 10 * 60_000 })
  } catch (error) {
    const failing = String(error?.stdout ?? '').split('\n').filter((line) => line.startsWith('not ok')).slice(0, 5).join('; ')
    log(`kept ${installed.slice(0, 7)}: master ${target.slice(0, 7)} fails the sync's tests${failing ? ` (${failing})` : ''}`)
    return
  }
  try {
    run(process.execPath, [path.join(SOURCE_DIR, 'scripts/install-switcher-health-sync.mjs'), '--apply'], { cwd: SOURCE_DIR, timeout: 2 * 60_000 })
  } catch (error) {
    log(`installing ${target.slice(0, 7)} failed, trying again next pass: ${lastLine(error)}`)
    return
  }
  saveState({ ...state, installed: target, installedAt: new Date().toISOString() })
  log(`installed ${target.slice(0, 7)} (was ${installed.slice(0, 7)})`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log(`update pass failed: ${lastLine(error)}`)
    process.exitCode = 1
  })
}
