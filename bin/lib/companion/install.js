import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateJson, readJson, stateRoot } from './store.js'

const quote = text => `'${text.replaceAll("'", "'\\''")}'`
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const label = 'com.tarioyou.codex-usage-companion'
const events = ['PermissionRequest', 'Notification', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionEnd']
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
function atomicText(file, text, mode) {
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, text, { mode, flag: 'wx' }); renameSync(temp, file); chmodSync(file, mode)
}
export function withHooks(settings, command, remove = false) {
  const result = structuredClone(settings)
  result.hooks ??= {}
  for (const event of events) {
    const entries = result.hooks[event] ?? []
    if (!Array.isArray(entries)) throw new Error('Unrecognized Claude hook settings')
    const cleaned = entries.flatMap(entry => {
      if (!(entry.hooks ?? []).some(h => h.command === command)) return [entry]
      const hooks = entry.hooks.filter(h => h.command !== command)
      return hooks.length ? [{ ...entry, hooks }] : []
    })
    if (!remove) cleaned.push({ ...(event === 'Notification' ? { matcher: 'permission_prompt' } : {}), hooks: [{ type: 'command', command, timeout: 3 }] })
    if (cleaned.length) result.hooks[event] = cleaned
    else delete result.hooks[event]
  }
  return result
}
export async function install(args) {
  if (process.platform !== 'darwin') throw new Error('Automatic installation currently supports macOS')
  if (args.length !== 2 || args[0] !== '--launcher') throw new Error('Specify the existing Codex launcher: install --launcher /absolute/path')
  const launcher = path.resolve(args[1]), home = os.homedir(), root = stateRoot()
  if (!path.isAbsolute(args[1]) || !launcher.startsWith(path.join(home, '.local/bin/'))) throw new Error('Use a user-owned launcher under ~/.local/bin')
  const stat = lstatSync(launcher)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Launcher must be a regular file owned by you')
  const manifestFile = path.join(root, 'installation.json')
  if (existsSync(manifestFile)) throw new Error('Companion is already installed; uninstall it before changing this installation')
  const probe = net.createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(3212, '127.0.0.1', resolve) })
  await new Promise(resolve => probe.close(resolve))
  const before = readFileSync(launcher, 'utf8')
  if (!before.startsWith('#!') || before.includes('companion.js')) throw new Error('Expected an existing shell launcher')
  const settingsFile = path.join(home, '.claude/settings.json')
  if (existsSync(settingsFile) && lstatSync(settingsFile).isSymbolicLink()) throw new Error('Claude settings must not be a symlink')
  const settingsBefore = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null
  const settings = settingsBefore === null ? {} : JSON.parse(settingsBefore)
  const source = fileURLToPath(new URL('../../', import.meta.url))
  const files = ['companion.js', ...readdirSync(path.join(source, 'lib/companion')).sort().map(n => `lib/companion/${n}`), ...readdirSync(path.join(source, 'companion-ui')).sort().map(n => `companion-ui/${n}`)]
  const hash = createHash('sha256')
  for (const file of files) hash.update(file).update(readFileSync(path.join(source, file)))
  const revision = hash.digest('hex').slice(0, 20)
  const release = path.join(home, '.local/share/codex-usage/companion', revision)
  mkdirSync(release, { recursive: true, mode: 0o700 })
  for (const file of files) { mkdirSync(path.dirname(path.join(release, file)), { recursive: true, mode: 0o700 }); cpSync(path.join(source, file), path.join(release, file)) }
  writeFileSync(path.join(release, 'package.json'), JSON.stringify({ type: 'module', private: true }), { mode: 0o600 })
  // Preserve before-states before touching either integration.
  const backup = path.join(root, `before-${randomUUID()}`)
  mkdirSync(backup, { recursive: true, mode: 0o700 })
  const upstream = path.join(backup, 'codex-launcher.sh')
  writeFileSync(upstream, before, { mode: 0o700 })
  if (settingsBefore !== null) writeFileSync(path.join(backup, 'claude-settings.json'), settingsBefore, { mode: 0o600 })
  const entry = path.join(release, 'companion.js')
  const hookCommand = `${quote(process.execPath)} ${quote(entry)} claude-hook`
  const settingsAfter = withHooks(settings, hookCommand)
  const launcherAfter = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} wrap -- ${quote(upstream)} "$@"\n`
  const agents = path.join(home, 'Library/LaunchAgents'); mkdirSync(agents, { recursive: true })
  const plist = path.join(agents, `${label}.plist`)
  if (existsSync(plist)) throw new Error('An existing companion LaunchAgent needs review before installation')
  const plistText = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string><string>serve</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(root, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(root, 'service-error.log'))}</string></dict></plist>`
  writeFileSync(path.join(backup, 'launch-agent.plist'), plistText, { mode: 0o600 })
  run('/usr/bin/plutil', ['-lint', path.join(backup, 'launch-agent.plist')])
  // Record restoration material before mutation, including a partial installation.
  privateJson(manifestFile, { launcher, launcherAfter, launcherMode: stat.mode & 0o777, upstream, settingsFile, hookCommand, plist, release, revision, backup })
  mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 })
  const settingsWritten = JSON.stringify(settingsAfter, null, 2) + '\n'
  try {
    // Detect another writer before replacing either live integration.
    if (readFileSync(launcher, 'utf8') !== before || (existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null) !== settingsBefore) throw new Error('Integration changed during installation')
    atomicText(settingsFile, settingsWritten, 0o600)
    atomicText(launcher, launcherAfter, stat.mode & 0o777)
    atomicText(plist, plistText, 0o600)
    run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist])
  } catch (error) {
    // Restore only bytes this transaction wrote; preserve concurrent edits.
    if (readFileSync(launcher, 'utf8') === launcherAfter) atomicText(launcher, before, stat.mode & 0o777)
    if (existsSync(settingsFile) && readFileSync(settingsFile, 'utf8') === settingsWritten) {
      if (settingsBefore !== null) atomicText(settingsFile, settingsBefore, 0o600)
      else renameSync(settingsFile, path.join(backup, 'failed-claude-settings.json'))
    }
    if (existsSync(plist) && readFileSync(plist, 'utf8') === plistText) renameSync(plist, path.join(backup, 'failed-launch-agent.plist'))
    renameSync(manifestFile, path.join(backup, 'failed-installation.json'))
    throw error
  }
  return { installed: true, url: 'http://127.0.0.1:3212', codex: 'Waiting for the next app launch; active sessions were not restarted', claude: 'Prompt observation only; approvals unchanged', revision }
}
export async function uninstall() {
  const root = stateRoot(), file = path.join(root, 'installation.json'), record = readJson(file, null)
  if (!record) throw new Error('No companion installation record')
  if (readFileSync(record.launcher, 'utf8') !== record.launcherAfter) throw new Error('The launcher changed since installation; refusing to overwrite newer work')
  const settings = readJson(record.settingsFile, {})
  const restored = withHooks(settings, record.hookCommand, true)
  try { run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]) } catch { /* Already stopped. */ }
  atomicText(record.launcher, readFileSync(record.upstream, 'utf8'), record.launcherMode)
  atomicText(record.settingsFile, JSON.stringify(restored, null, 2) + '\n', 0o600)
  if (existsSync(record.plist)) renameSync(record.plist, path.join(record.backup, 'uninstalled-launch-agent.plist'))
  renameSync(file, path.join(record.backup, 'uninstalled.json'))
  return { uninstalled: true, backups: record.backup, activeSessions: 'Unchanged until their next launch' }
}
