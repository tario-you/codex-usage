import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { accountStateSchema, rateLimitsSchema } from '../api/_lib/schemas.ts'
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_TOKEN_URL,
  CLAUDE_USAGE_URL,
  buildClaudeSyncPayload,
  discoverClaudeLogins,
  fetchClaudeUsage,
  syncClaudeOnce,
} from '../bin/lib/claude-logins.js'

const usageBody = (session, weekly, extra = {}) => ({
  five_hour: { utilization: session, resets_at: '2026-09-11T07:10:00.191013+00:00' },
  seven_day: { utilization: weekly, resets_at: '2026-09-11T10:00:00.191037+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  ...extra,
})
const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) })

test('the Claude usage response becomes a payload the dashboard sync schema accepts', () => {
  const payload = buildClaudeSyncPayload(usageBody(70, 14, { seven_day_opus: { utilization: 3, resets_at: '2026-09-11T10:00:00Z' } }), { email: 'a@example.com', planType: 'max' })
  assert.deepEqual(accountStateSchema.parse(payload.accountState).account, { type: 'claude', email: 'a@example.com', planType: 'max' })
  const limits = rateLimitsSchema.parse(payload.rateLimits)
  assert.equal(limits.rateLimits.limitId, 'claude')
  assert.equal(limits.rateLimits.primary.usedPercent, 70)
  assert.equal(limits.rateLimits.primary.windowDurationMins, 300, 'the session window is the 5-hour one')
  assert.equal(limits.rateLimits.primary.resetsAt, Math.floor(Date.parse('2026-09-11T07:10:00.191013+00:00') / 1000))
  assert.equal(limits.rateLimits.secondary.usedPercent, 14)
  assert.equal(limits.rateLimits.secondary.windowDurationMins, 10080, 'the weekly window is the second one')
  assert.deepEqual(Object.keys(limits.rateLimitsByLimitId).sort(), ['claude', 'claude_opus'])
  assert.equal(limits.rateLimitsByLimitId.claude_opus.primary, null)
})

test('discovery reads saved switcher logins, the CLI credential file, and the desktop token, folding a token reached twice', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-claude-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const storePath = path.join(dir, 'accounts.json')
  const credentialsPath = path.join(dir, '.credentials.json')
  await writeFile(storePath, JSON.stringify({ version: 1, accounts: [
    { id: 'one', email: 'A@Example.com', subscription_type: 'max', oauth: { accessToken: 'acc-one', refreshToken: 'ref-one', expiresAt: 1 } },
    { id: 'dead', email: 'dead@example.com', oauth: {} },
  ] }))
  await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'acc-cli', refreshToken: 'ref-cli', expiresAt: 2, subscriptionType: 'pro' } }))
  const logins = await discoverClaudeLogins({ storePath, credentialsPath, keychain: () => null, desktopToken: () => 'acc-cli' })
  assert.deepEqual(logins.map((login) => [login.source, login.email, login.oauth.subscriptionType]), [['switcher', 'a@example.com', 'max'], ['cli', null, 'pro']])
  const withDesktop = await discoverClaudeLogins({ storePath, credentialsPath, keychain: () => null, desktopToken: () => 'acc-desktop' })
  assert.deepEqual(withDesktop.map((login) => login.source), ['switcher', 'cli', 'desktop'])
  assert.equal(withDesktop[2].oauth.refreshToken, null, 'the desktop token has no refresh token of its own')
})

test('a 401 gets one refresh and one retry; a login with no refresh token is an expired sign-in', async () => {
  const calls = []
  const fetcher = async (url, options = {}) => {
    calls.push(url)
    if (url === CLAUDE_TOKEN_URL) return json({ access_token: 'acc-new', refresh_token: 'ref-new', expires_in: 3600 })
    const token = options.headers?.Authorization
    if (url === CLAUDE_USAGE_URL) return token === 'Bearer acc-new' ? json(usageBody(1, 2)) : json({ error: { message: 'unauthorized' } }, 401)
    throw new Error(`unexpected ${url}`)
  }
  const refreshed = await fetchClaudeUsage({ accessToken: 'acc-old', refreshToken: 'ref-old' }, fetcher)
  assert.equal(refreshed.refreshed, true)
  assert.equal(refreshed.oauth.accessToken, 'acc-new')
  assert.equal(refreshed.data.five_hour.utilization, 1)
  assert.deepEqual(calls, [CLAUDE_USAGE_URL, CLAUDE_TOKEN_URL, CLAUDE_USAGE_URL])
  const expired = await fetchClaudeUsage({ accessToken: 'acc-dead', refreshToken: null }, fetcher)
  assert.match(expired.error, /sign-in expired/)
})

test('sync reports one row per email, prefers the login with a refresh token, and writes a refreshed switcher token back', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-claude-sync-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const storePath = path.join(dir, 'accounts.json')
  await writeFile(storePath, JSON.stringify({ version: 1, accounts: [{ id: 'one', email: 'a@example.com', oauth: { accessToken: 'acc-stale', refreshToken: 'ref-one' } }] }))
  const logins = [
    { id: 'desktop', source: 'desktop', email: null, oauth: { accessToken: 'acc-desktop', refreshToken: null, subscriptionType: null } },
    { id: 'one', source: 'switcher', email: 'a@example.com', oauth: { accessToken: 'acc-stale', refreshToken: 'ref-one', subscriptionType: 'max' } },
    { id: 'cli', source: 'cli', email: null, oauth: { accessToken: 'acc-b', refreshToken: 'ref-b', subscriptionType: 'pro' } },
  ]
  const posts = []
  const fetcher = async (url, options = {}) => {
    const token = options.headers?.Authorization ?? ''
    if (url === CLAUDE_PROFILE_URL) {
      if (token.endsWith('acc-b')) return json({ account: { email: 'B@example.com' }, organization: { organization_type: 'claude_pro' } })
      return json({ account: { email: 'a@example.com' }, organization: { organization_type: 'claude_max' } })
    }
    if (url === CLAUDE_TOKEN_URL) return json({ access_token: 'acc-fresh', refresh_token: 'ref-fresh', expires_in: 60 })
    if (url === CLAUDE_USAGE_URL) {
      if (token.endsWith('acc-stale')) return json({}, 401)
      if (token.endsWith('acc-fresh')) return json(usageBody(70, 14))
      if (token.endsWith('acc-b')) return json(usageBody(5, 40))
      throw new Error(`unexpected token ${token}`)
    }
    if (url === 'https://dash.example/api/sync') {
      posts.push(JSON.parse(options.body))
      return { ok: true, status: 200 }
    }
    throw new Error(`unexpected ${url}`)
  }
  const summary = await syncClaudeOnce({ config: { syncUrl: 'https://dash.example/api/sync', deviceToken: 'dev-token' }, device: { label: 'mac' }, fetcher, logins, storePath })
  assert.equal(summary.total, 3)
  assert.equal(summary.synced, 2, 'three logins named two emails')
  assert.deepEqual(summary.results.map((r) => [r.email, r.ok, r.source, r.planType, r.usedPercent]), [['a@example.com', true, 'switcher', 'max', 70], ['b@example.com', true, 'cli', 'pro', 5]])
  assert.deepEqual(posts.map((post) => post.accountState.account), [{ type: 'claude', email: 'a@example.com', planType: 'max' }, { type: 'claude', email: 'b@example.com', planType: 'pro' }])
  assert.equal(posts[0].deviceToken, 'dev-token')
  const store = JSON.parse(await readFile(storePath, 'utf8'))
  assert.equal(store.accounts[0].oauth.accessToken, 'acc-fresh', 'the refreshed switcher token is written back')
  assert.equal(store.accounts[0].oauth.refreshToken, 'ref-fresh')
})
