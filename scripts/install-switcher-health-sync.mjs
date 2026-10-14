#!/usr/bin/env node
// Replace only the hosted metadata uploader, retaining its pairing and before-state.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv.slice(2).join(' ') !== '--apply') throw new Error('Use --apply')
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const files = ['bin/switcher-health-agent.js', 'bin/lib/sync-all.js', 'bin/lib/login-file.js', 'bin/lib/reset-credits.js', 'bin/lib/plan-order.js', 'bin/lib/dashboard-request.js', 'bin/lib/claude-logins.js', 'bin/lib/system-proxy.js']
if (run('git', ['-C', root, 'status', '--porcelain', '--', ...files, 'scripts/install-switcher-health-sync.mjs']).trim()) throw new Error('Commit the uploader before installing its snapshot')
const revision = run('git', ['-C', root, 'rev-parse', 'HEAD']).trim()
const home = os.homedir(), label = 'com.tarioyou.codex-usage-sync-all'
const plist = path.join(home, 'Library/LaunchAgents', label + '.plist')
if (!existsSync(plist)) throw new Error('The paired hosted uploader must already be installed')
const release = path.join(home, '.local/share/codex-usage/sync-agent', revision)
mkdirSync(path.join(release, 'bin/lib'), { recursive: true, mode: 0o700 })
for (const file of files) copyFileSync(path.join(root, file), path.join(release, file))
writeFileSync(path.join(release, 'package.json'), '{"type":"module"}\n', { mode: 0o600 })
run('node', ['--input-type=module', '-e', 'import(' + JSON.stringify(path.join(release, 'bin/lib/sync-all.js')) + ')'])
const prior = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]))
const configPath = path.join(home, '.codex/codex-usage-sync.json')
const paired = JSON.parse(readFileSync(configPath, 'utf8'))
if (new URL(paired.syncUrl).origin !== 'https://codexusage.vercel.app') throw new Error('The uploader is paired to another site')
copyFileSync(plist, plist + '.before-' + Date.now())
prior.ProgramArguments = [process.execPath, path.join(release, 'bin/switcher-health-agent.js'), configPath]
const candidate = path.join(release, 'uploader-plist.json')
writeFileSync(candidate, JSON.stringify(prior), { mode: 0o600 })
run('/usr/bin/plutil', ['-convert', 'xml1', '-o', plist, candidate])
run('/usr/bin/plutil', ['-lint', plist])
const domain = 'gui/' + process.getuid()
try { run('/bin/launchctl', ['bootout', domain + '/' + label]) } catch {}
for (let attempt=0;;attempt++) { try { run('/bin/launchctl', ['bootstrap', domain, plist]); break } catch (error) { if (attempt===4) throw error; await new Promise(resolve=>setTimeout(resolve,1000)) } }
console.log(JSON.stringify({ installed: 'switcher-health-uploader', revision, sessionsOpened: false }))
