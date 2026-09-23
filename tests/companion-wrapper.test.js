import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../bin/companion.js', import.meta.url))
function session(t, upstream, args = ['app-server'], unavailableState = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'companion-wire-'))
  const fake = path.join(root, 'fake-codex')
  writeFileSync(fake, `#!${process.execPath}\n${upstream}`, { mode: 0o700 })
  const child = spawn(process.execPath, [entry, 'wrap', '--', fake, ...args], { env: { ...process.env, CODEX_COMPANION_STATE_DIR: unavailableState ? fake : root }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', c => { stderr += c })
  const lines = [], waiters = []
  createInterface({ input: child.stdout }).on('line', l => { lines.push(l); waiters.shift()?.(l) })
  const next = () => new Promise(resolve => waiters.push(resolve))
  const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stderr })) })
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exit; rmSync(root, { recursive: true, force: true }) })
  return { root, child, next, lines, exit }
}

test('real wrapper forwards server approvals and the owner response byte-for-byte', { timeout: 5000 }, async t => {
  const s = session(t, `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){console.log(JSON.stringify({id:m.id,result:{}}));console.log(JSON.stringify({id:55,method:'item/commandExecution/requestApproval',params:{threadId:'task',command:'private command'}}));}else console.log(line);});`)
  const first = s.next(); s.child.stdin.write('{"id":1,"method":"initialize","params":{}}\n'); await first
  // Wait for approval output, then explicitly emulate the owner's decline.
  if (s.lines.length < 2) await s.next()
  assert.equal(JSON.parse(s.lines[1]).method, 'item/commandExecution/requestApproval')
  const echo = s.next(); const decision = '{ "id":55, "result":{"decision":"decline"} }'
  s.child.stdin.write(decision + '\n'); assert.equal(await echo, decision)
  assert.equal(s.lines.length, 3, 'no automatic answer was injected')
})

test('split UTF-8 survives a real upstream process and exit status is preserved', { timeout: 5000 }, async t => {
  const s = session(t, `const b=Buffer.from('{"text":"hello 🌙"}\\n');process.stdout.write(b.subarray(0,17));setTimeout(()=>{process.stdout.write(b.subarray(17));process.exitCode=7},20);`)
  const result = await s.exit
  assert.equal(result.code, 7)
  assert.deepEqual(s.lines, ['{"text":"hello 🌙"}'])
})

test('non-server commands are delegated without a recovery connection', { timeout: 5000 }, async t => {
  const s = session(t, `console.log('codex-version-fixture')`, ['--version'])
  assert.equal((await s.exit).code, 0)
  assert.deepEqual(s.lines, ['codex-version-fixture'])
  assert.equal(readdirSync(s.root).includes('connections'), false)
})

test('paused Claude approvals exit silently and leave the permission request waiting', { timeout: 5000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'companion-hook-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ enabled: true, claudeAutoApprove: false }))
  const child = spawn(process.execPath, [entry, 'claude-hook'], { env: { ...process.env, CODEX_COMPANION_STATE_DIR: root } })
  let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c)
  child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'fixture', tool_name: 'Bash', tool_input: { command: 'PRIVATE' } }))
  const code = await new Promise(resolve => child.once('close', resolve))
  assert.equal(code, 0); assert.equal(stdout, ''); assert.equal(stderr, '')
  const files = readdirSync(path.join(root, 'claude')); assert.equal(files.length, 1)
  assert.equal(JSON.parse(readFileSync(path.join(root, 'claude', files[0]))).waiting, true)
})


test('an unavailable companion directory cannot prevent Codex from starting', { timeout: 5000 }, async t => {
  const s = session(t, `console.log('upstream still runs')`, ['app-server'], true)
  const result = await s.exit
  assert.equal(result.code, 0)
  assert.deepEqual(s.lines, ['upstream still runs'])
  assert.match(result.stderr, /continues without automatic retries/)
})
