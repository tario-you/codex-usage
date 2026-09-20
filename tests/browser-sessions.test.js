import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { browserSessionTarget, chromeLaunchArgs, openBrowserSession, runBrowserPass } from '../bin/lib/browser-sessions.js'

const id = '11111111-1111-4111-8111-111111111111'
const now = Date.parse('2026-09-20T20:00:00Z')
const pending = { id, provider: 'codex', email: 'fixture@example.com', expires_at: new Date(now + 60000).toISOString() }
const config = { dashboardOrigin: 'https://example.com', syncUrl: 'https://example.com/api/sync', deviceToken: 'fixture-device' }

test('provider and normalized email select stable distinct private profiles and fixed websites', () => {
  const a = browserSessionTarget('codex', 'Fixture@Example.com', '/private/profiles')
  assert.deepEqual(a, browserSessionTarget('codex', 'fixture@example.com', '/private/profiles'))
  assert.notEqual(a.directory, browserSessionTarget('claude', 'fixture@example.com', '/private/profiles').directory)
  assert.notEqual(a.directory, browserSessionTarget('codex', 'other@example.com', '/private/profiles').directory)
  assert.equal(a.url, 'https://chatgpt.com/')
  assert.equal(browserSessionTarget('claude', pending.email).url, 'https://claude.ai/')
  assert.ok(!a.directory.includes('@'))
  const args = chromeLaunchArgs(a)
  assert.ok(args.includes(`--user-data-dir=${a.directory}`))
  assert.equal(args.at(-1), 'https://chatgpt.com/')
  assert.throws(() => browserSessionTarget('https://attacker.invalid', pending.email))
  assert.throws(() => browserSessionTarget('codex', '../../etc/passwd'))
})

test('reopening a session preserves its browser data; launches are stubbed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-session-'))
  const launches = []
  try {
    const options = { root, launch: async args => launches.push(args) }
    const first = await openBrowserSession('codex', pending.email, options)
    await writeFile(path.join(first.directory, 'session-fixture'), 'preserve me')
    const second = await openBrowserSession('codex', pending.email, options)
    assert.equal(await readFile(path.join(second.directory, 'session-fixture'), 'utf8'), 'preserve me')
    assert.deepEqual(launches[0], launches[1])
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function pass(request, open = async () => {}) {
  const calls = []
  const result = await runBrowserPass(config, {
    now: () => now, open,
    fetcher: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) })
      return new Response(JSON.stringify(String(url).endsWith('/poll') ? { pending: request } : { ok: true }))
    },
  })
  return { result, calls }
}

test('a valid click opens only its provider/email and acknowledges its exact request id', async () => {
  const opens = []
  const { result, calls } = await pass(pending, async (...args) => opens.push(args))
  assert.equal(result, true)
  assert.deepEqual(opens, [['codex', pending.email]])
  assert.deepEqual(calls[1].body, { deviceToken: config.deviceToken, requestId: id, outcome: 'opened' })
})

test('idle, expired, malformed, or failed requests never claim a successful browser open', async () => {
  assert.equal((await pass(null)).calls.length, 1)
  for (const bad of [
    { ...pending, expires_at: new Date(now - 1).toISOString() },
    { ...pending, expires_at: 'invalid' },
    { ...pending, provider: 'constructor' },
    { ...pending, email: '--user-data-dir=/tmp/injected' },
  ]) {
    let opened = false
    const { result, calls } = await pass(bad, async () => { opened = true })
    assert.equal(opened, false)
    assert.equal(result, false)
    assert.equal(calls[1].body.outcome, 'failed')
  }
  assert.equal((await pass(pending, async () => { throw new Error('cannot open') })).result, false)
})
