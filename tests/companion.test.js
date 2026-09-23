import test from 'node:test'
import http from 'node:http'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { transientFailure } from '../bin/lib/companion/policy.js'
import { RecoveryStore, privateJson } from '../bin/lib/companion/store.js'
import { RecoveryCompanion } from '../bin/lib/companion/recovery.js'
import { recordClaudeEvent } from '../bin/lib/companion/claude.js'
import { withHooks } from '../bin/lib/companion/install.js'
import { startServer, snapshot } from '../bin/lib/companion/server.js'

const failure = (info = { responseStreamDisconnected: { httpStatusCode: null } }, id = 'failed-turn') => ({ id, status: 'failed', error: { codexErrorInfo: info, message: 'not used for classification' } })
function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-companion-'))
  const store = new RecoveryStore(root)
  const sent = []
  const c = new RecoveryCompanion({ store, send: message => sent.push(message), delays: [5, 5, 5], timeoutMs: 100, ...options })
  c.fromClient({ method: 'initialized' })
  t.after(() => { c.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, store, c, sent, fail: (turn = failure()) => c.fromServer({ method: 'turn/completed', params: { threadId: 'task', turn } }) }
}
async function waitFor(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await delay(2) } assert.fail('Expected event did not arrive') }
function readResponse(c, request, turn = failure(), status = 'idle') {
  return c.fromServer({ id: request.id, result: { thread: { id: 'task', status: { type: status }, turns: [turn] } } })
}

test('only structured transient errors qualify, including HTTP status exclusions', () => {
  for (const info of ['serverOverloaded', 'internalServerError', { httpConnectionFailed: { httpStatusCode: 503 } }, { responseStreamDisconnected: { httpStatusCode: null } }]) assert.equal(transientFailure(failure(info)), true)
  for (const info of ['misalignmentPolicyViolation', 'usageLimitExceeded', 'unauthorized', 'sandboxError', 'other', null, { httpConnectionFailed: { httpStatusCode: 403 } }, { responseStreamDisconnected: { httpStatusCode: 401 } }, { httpConnectionFailed: {} }]) assert.equal(transientFailure(failure(info)), false)
  assert.equal(transientFailure({ ...failure(), status: 'interrupted' }), false)
  assert.equal(transientFailure({ ...failure(), error: { codexErrorInfo: 'internalServerError', misalignment: { reason: 'needs review' } } }), false)
  assert.equal(transientFailure({ ...failure('other'), error: { codexErrorInfo: 'other', message: 'serverOverloaded connection failure' } }), false)
})

test('same connection retry checks the latest turn and sends no model or permissions override', async t => {
  const { c, sent, fail, store } = fixture(t)
  fail(); await waitFor(() => sent.length === 1)
  assert.equal(sent[0].method, 'thread/read')
  assert.equal(readResponse(c, sent[0]), true)
  await waitFor(() => sent.length === 2)
  assert.equal(sent[1].method, 'turn/start')
  assert.deepEqual(Object.keys(sent[1].params).sort(), ['input', 'threadId'])
  assert.equal(sent[1].params.threadId, 'task')
  assert.equal(store.attempts('task', Date.now()).length, 1)
  c.fromServer({ id: sent[1].id, result: { turn: { id: 'resumed' } } })
  fail(); await delay(15)
  assert.equal(sent.length, 2, 'the exact failed turn cannot be retried twice')
})

test('user stop arriving during revalidation cancels the retry', async t => {
  const { c, sent, fail } = fixture(t)
  fail(); await waitFor(() => sent.length === 1)
  c.fromClient({ id: 100, method: 'turn/interrupt', params: { threadId: 'task', turnId: 'failed-turn' } })
  readResponse(c, sent[0]); await delay(10)
  assert.equal(sent.length, 1)
})

test('new turns, active threads, and input requests prevent automatic continuation', async t => {
  for (const [turn, status] of [[failure('internalServerError', 'new-turn'), 'idle'], [failure(), 'active'], [failure(), 'notLoaded']]) {
    const { c, sent, fail } = fixture(t)
    fail(); await waitFor(() => sent.length === 1)
    readResponse(c, sent[0], turn, status); await delay(10)
    assert.equal(sent.length, 1)
  }
  const { c, sent, fail } = fixture(t)
  const approval = { id: 80, method: 'item/commandExecution/requestApproval', params: { threadId: 'task' } }
  assert.equal(c.fromServer(approval), false, 'approval is forwarded to the app')
  fail(); await delay(10); assert.equal(sent.length, 0)
})

test('pausing the companion while a retry waits prevents any request', async t => {
  const { root, sent, fail } = fixture(t)
  fail(); privateJson(path.join(root, 'settings.json'), { enabled: false })
  await delay(15); assert.equal(sent.length, 0)
})

test('safety stops, cancellations, quota and unknown failures never schedule retries', async t => {
  const { fail, sent } = fixture(t)
  for (const info of ['misalignmentPolicyViolation', 'usageLimitExceeded', 'sandboxError', 'unauthorized', 'other']) fail(failure(info))
  fail({ ...failure(), status: 'interrupted' })
  await delay(15); assert.equal(sent.length, 0)
})

test('claims survive a new store instance, cap retries, and reject corrupt state', t => {
  const { root, store } = fixture(t)
  assert.equal(store.claim('task', '1', 100), true)
  assert.equal(new RecoveryStore(root).claim('task', '1', 101), false)
  assert.equal(store.claim('task', '2', 102), true)
  assert.equal(store.claim('task', '3', 103), true)
  assert.equal(store.claim('task', '4', 104), false)
  assert.equal(store.claim('task', '5', 3_600_104), true)
  privateJson(store.file('task'), { unexpected: true })
  assert.throws(() => store.claim('task', '6', 3_600_105), /Invalid recovery ledger/)
})

test('late private RPC responses never leak into the app', async t => {
  const { c, sent } = fixture(t, { timeoutMs: 5 })
  await assert.rejects(c.request('thread/read', { threadId: 'task' }), /timed out/)
  assert.equal(c.fromServer({ id: sent[0].id, result: {} }), true)
  assert.equal(c.fromServer({ id: 'real-app-id', result: {} }), false)
})

test('Claude hooks store no prompt, path or arguments, and never change permissions', t => {
  const { root } = fixture(t)
  const before = { permissions: { deny: ['Bash(rm *)'], ask: ['Write'] }, hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing' }] }] } }
  const after = withHooks(before, 'our-observer')
  assert.deepEqual(after.permissions, before.permissions)
  assert.equal(after.hooks.PermissionRequest[0].hooks[0].command, 'existing')
  assert.deepEqual(withHooks(after, 'our-observer', true), before)
  assert.equal(recordClaudeEvent({ session_id: 'one', hook_event_name: 'PermissionRequest', tool_input: { command: 'SECRET' }, cwd: '/private/path', message: 'PRIVATE' }, root), true)
  const status = snapshot(root)
  assert.equal(status.claude.length, 1)
  const saved = readFileSync(path.join(root, 'claude', `${status.claude[0].id}.json`), 'utf8')
  for (const text of ['SECRET', '/private/path', 'PRIVATE', 'one']) assert.equal(saved.includes(text), false)
  recordClaudeEvent({ session_id: 'one', hook_event_name: 'PostToolUse' }, root)
  assert.equal(snapshot(root).claude.length, 0)
})

test('local dashboard rejects foreign origins, missing cookies and malformed settings', async t => {
  const { root } = fixture(t)
  const app = await startServer({ root, port: 0 }); t.after(() => app.close())
  assert.equal((await fetch(`${app.origin}/api/status`)).status, 401)
  const page = await fetch(app.origin)
  const cookie = page.headers.get('set-cookie').split(';')[0]
  assert.match(await page.text(), /Task companion/)
  assert.equal((await fetch(`${app.origin}/api/status`, { headers: { cookie } })).status, 200)
  assert.equal((await fetch(`${app.origin}/api/status`, { headers: { cookie, origin: 'https://evil.example' } })).status, 403)
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(`${app.origin}/api/status`, { headers: { cookie, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject)
  })
  assert.equal(foreignHostStatus, 403)
  const put = (data, origin = app.origin) => fetch(`${app.origin}/api/settings`, { method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  assert.equal((await put({ enabled: false }, 'https://evil.example')).status, 403)
  assert.equal((await put({ enabled: 'yes' })).status, 400)
  assert.equal((await put({ enabled: false })).status, 200)
  assert.equal(snapshot(root).enabled, false)
})

test('a failed completion arriving after a manual stop remains stopped', async t => {
  const { c, sent, fail } = fixture(t)
  c.fromClient({ id: 77, method: 'turn/interrupt', params: { threadId: 'task' } })
  fail(); await delay(15); assert.equal(sent.length, 0)
  c.fromClient({ id: 78, method: 'turn/start', params: { threadId: 'task', input: [] } })
  fail(); await waitFor(() => sent.length === 1)
  assert.equal(sent[0].method, 'thread/read')
})
