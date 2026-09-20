#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const label = 'com.tarioyou.codex-usage-browser'
if (!process.argv.includes('--apply')) throw new Error('Use --apply to install the browser helper for this Mac.')
if (process.platform !== 'darwin' || !existsSync('/Applications/Google Chrome.app')) throw new Error('Google Chrome on macOS is required.')
const home = os.homedir()
const configPath = path.join(home, '.codex/codex-usage-sync.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
if (!config.deviceToken || !config.syncUrl) throw new Error('Pair this machine with the dashboard first.')
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const release = path.join(home, '.local/share/codex-usage/browser-helper', revision)
mkdirSync(path.join(release, 'bin/lib'), { recursive: true, mode: 0o700 })
for (const file of ['bin/browser-agent.js', 'bin/lib/browser-sessions.js', 'bin/lib/dashboard-request.js']) {
  copyFileSync(path.join(root, file), path.join(release, file))
}
writeFileSync(path.join(release, 'package.json'), '{"type":"module"}\n', { mode: 0o600 })
const logDir = path.join(home, 'Library/Logs/codex-usage-browser')
mkdirSync(logDir, { recursive: true, mode: 0o700 })
const plist = path.join(home, 'Library/LaunchAgents', `${label}.plist`)
const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(path.join(release, 'bin/browser-agent.js'))}</string><string>${esc(configPath)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${esc(path.join(logDir, 'agent.log'))}</string>
<key>StandardErrorPath</key><string>${esc(path.join(logDir, 'agent.error.log'))}</string>
</dict></plist>\n`
if (existsSync(plist)) copyFileSync(plist, `${plist}.before-${Date.now()}`)
writeFileSync(plist, content, { mode: 0o600 })
execFileSync('/usr/bin/plutil', ['-lint', plist], { stdio: 'pipe' })
const domain = `gui/${process.getuid()}`
// Replace only this helper's own launchd service; existing sync agents keep running.
try { execFileSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'pipe' }) } catch { /* First install. */ }
execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { stdio: 'pipe' })
console.log(`Browser helper installed from ${revision}. Chrome opens only when an account is clicked.`)
