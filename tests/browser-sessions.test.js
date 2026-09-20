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
  const codexUrl = new URL(a.url)
  assert.equal(codexUrl.origin + codexUrl.pathname, 'https://chatgpt.com/auth/login_with')
  assert.equal(codexUrl.searchParams.get('login_hint'), 'fixture@example.com')
  assert.equal(codexUrl.searchParams.get('screen_hint'), 'login')
  assert.equal(codexUrl.searchParams.get('callback_path'), '/')
  const claudeUrl = new URL(browserSessionTarget('claude', pending.email).url)
  assert.equal(claudeUrl.origin + claudeUrl.pathname, 'https://claude.ai/login')
  assert.equal(claudeUrl.searchParams.get('email'), pending.email)
  assert.ok(!a.directory.includes('@'))
  const args = chromeLaunchArgs(a)
  assert.ok(args.includes(`--profile-directory=${a.profile}`))
  assert.equal(path.basename(a.directory), a.profile)
  assert.ok(!args.some(arg => arg.startsWith('--user-data-dir') || arg === '-n'))
  assert.equal(args.at(-1), a.url)
  assert.throws(() => browserSessionTarget('https://attacker.invalid', pending.email))
  assert.throws(() => browserSessionTarget('codex', '../../etc/passwd'))
})

test('reopening a session preserves its browser data; launches are stubbed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-session-'))
  const launches = []
  try {
    const events = []
    const options = { root, launch: async args => { launches.push(args); events.push('launch') }, activate: async () => { events.push('activate') } }
    const first = await openBrowserSession('codex', pending.email, options)
    await writeFile(path.join(first.directory, 'session-fixture'), 'preserve me')
    const second = await openBrowserSession('codex', pending.email, options)
    assert.equal(await readFile(path.join(second.directory, 'session-fixture'), 'utf8'), 'preserve me')
    assert.deepEqual(launches[0], launches[1])
    assert.deepEqual(events, ['launch', 'activate', 'launch', 'activate'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('email hints preserve aliases and cannot inject redirects or other URL parameters', () => {
  const email = 'fixture+tag&next=elsewhere#name@example.com'
  for (const provider of ['codex', 'claude']) {
    const url = new URL(browserSessionTarget(provider, email).url)
    assert.equal(url.searchParams.get(provider === 'codex' ? 'login_hint' : 'email'), email)
    assert.equal(url.hash, '')
    assert.equal(url.searchParams.has('next'), false)
    assert.equal(url.searchParams.has('prompt'), false)
    assert.equal(url.searchParams.has('selectAccount'), false)
  }
})

test('failed dispatch does not activate a different Chrome window', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-failure-'))
  let activated = false
  try {
    await assert.rejects(openBrowserSession('codex', pending.email, {
      root, launch: async () => { throw new Error('dispatch failed') }, activate: async () => { activated = true },
    }), /dispatch failed/)
    assert.equal(activated, false)
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
  assert.deepEqual(opens, [['codex', pending.email, { loginMethod: 'email' }]])
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


test('Google opens ChatGPT social login with the email hint and reuses the same profile', () => {
  const regular = browserSessionTarget('codex', pending.email)
  const google = browserSessionTarget('codex', pending.email, undefined, 'google')
  const url = new URL(google.url)
  assert.equal(url.searchParams.get('connection'), 'google-oauth2')
  assert.equal(url.searchParams.get('login_hint'), pending.email)
  assert.equal(google.directory, regular.directory)
  assert.equal(new URL(regular.url).searchParams.has('connection'), false)
  const claude = new URL(browserSessionTarget('claude', pending.email, undefined, 'google').url)
  assert.equal(claude.origin + claude.pathname, 'https://claude.ai/login')
  assert.equal(claude.searchParams.get('email'), pending.email)
  assert.equal(claude.searchParams.has('force_login'), false)
  assert.throws(() => browserSessionTarget('codex', pending.email, undefined, 'injected'))
})

test('device launches carry the requested sign-in method and reject invalid methods', async () => {
  const opens = []
  assert.equal((await pass({ ...pending, login_method: 'google' }, async (...args) => opens.push(args))).result, true)
  assert.deepEqual(opens, [['codex', pending.email, { loginMethod: 'google' }]])
  assert.equal((await pass({ ...pending, login_method: 'evil' }, async () => { throw new Error('must not open') })).result, false)
})
