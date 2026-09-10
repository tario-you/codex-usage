import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { accountStateSchema, rateLimitsSchema } from '../api/_lib/schemas.ts'
import {
  buildSyncPayloadFromUsage,
  fetchUsage,
  readStore,
  syncAllOnce,
  upsertStoreAccount,
} from '../bin/lib/sync-all.js'

const jwt = (email, plan = 'pro') =>
  `e30.${Buffer.from(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: plan, chatgpt_subscription_active_until: '2027-01-01T00:00:00Z' } })).toString('base64url')}.sig`
const authFile = (id, email) => ({
  OPENAI_API_KEY: null,
  auth_mode: 'chatgpt',
  last_refresh: '2026-09-09T00:00:00.000Z',
  tokens: { account_id: id, id_token: jwt(email), access_token: `access-${id}`, refresh_token: `refresh-${id}` },
})
const usageBody = (used, extras = []) => ({
  plan_type: 'pro',
  rate_limit: { allowed: used < 100, limit_reached: used >= 100, primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: 1_789_453_355 }, secondary_window: null },
  additional_rate_limits: extras,
  credits: { has_credits: false, unlimited: false, balance: '0' },
  rate_limit_reset_credits: { available_count: 2, applicable_available_count: 1 },
})

test('the usage endpoint response becomes a payload the dashboard sync schema accepts', () => {
  const payload = buildSyncPayloadFromUsage(usageBody(42, [{ limit_name: 'Spark', metered_feature: 'codex_spark', rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 5 } } }]), 'a@example.com')
  assert.deepEqual(accountStateSchema.parse(payload.accountState).account, { type: 'chatgpt', email: 'a@example.com', planType: 'pro' })
  const limits = rateLimitsSchema.parse(payload.rateLimits)
  assert.equal(limits.rateLimits.primary.usedPercent, 42)
  assert.equal(limits.rateLimits.primary.windowDurationMins, 10080)
  assert.equal(limits.rateLimits.secondary, null)
  assert.deepEqual(Object.keys(limits.rateLimitsByLimitId).sort(), ['codex', 'codex_spark'])
  assert.equal(limits.rateLimitsByLimitId.codex_spark.primary.windowDurationMins, 300)
  assert.deepEqual(limits.rateLimits.resetCredits, { applicable: 1, available: 2 }, 'the reset credits ride the snapshot')
})

test('login add saves a new account with its plan and updates an existing one in place', () => {
  const store = { version: 1, accounts: [] }
  const first = upsertStoreAccount(store, authFile('acc-a', 'A@Example.com'))
  assert.equal(first.created, true)
  assert.equal(first.account.email, 'A@Example.com')
  assert.equal(first.account.plan_type, 'pro')
  assert.equal(first.account.auth_data.type, 'chat_g_p_t')
  const again = upsertStoreAccount(store, { ...authFile('acc-a', 'a@example.com'), tokens: { ...authFile('acc-a', 'a@example.com').tokens, access_token: 'newer' } })
  assert.equal(again.created, false)
  assert.equal(again.account.id, first.account.id)
  assert.equal(store.accounts.length, 1)
  assert.equal(store.accounts[0].auth_data.access_token, 'newer')
})

test('sync --all reports every saved login, refreshes an expired token once, skips a dead one, and includes the active login', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-sync-all-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const storePath = path.join(dir, 'accounts.json')
  const store = { version: 1, accounts: [] }
  for (const [id, email] of [['acc-a', 'a@example.com'], ['acc-b', 'b@example.com'], ['acc-c', 'c@example.com']]) upsertStoreAccount(store, authFile(id, email))
  await writeFile(storePath, JSON.stringify(store))

  const posts = []
  const fetcher = async (url, options = {}) => {
    const headers = options.headers ?? {}
    if (url === 'https://auth.openai.com/oauth/token') {
      const body = JSON.parse(options.body)
      if (body.refresh_token === 'refresh-acc-b') return { ok: true, status: 200, json: async () => ({ access_token: 'access-acc-b-new', refresh_token: 'refresh-acc-b-new' }) }
      return { ok: false, status: 400, json: async () => ({}) }
    }
    if (url === 'https://chatgpt.com/backend-api/wham/usage') {
      const token = headers.Authorization
      if (token === 'Bearer access-acc-a') return { ok: true, status: 200, json: async () => usageBody(10) }
      if (token === 'Bearer access-acc-b-new') return { ok: true, status: 200, json: async () => usageBody(100) }
      if (token === 'Bearer access-acc-d') return { ok: true, status: 200, json: async () => usageBody(3) }
      return { ok: false, status: 401, json: async () => ({}) }
    }
    if (url === 'https://dashboard.test/api/sync') { posts.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({}) } }
    throw new Error(`unexpected ${url}`)
  }

  const summary = await syncAllOnce({
    activeAuthFile: authFile('acc-d', 'd@example.com'),
    config: { deviceToken: 'device-token', syncUrl: 'https://dashboard.test/api/sync' },
    device: { codexHome: '/x', label: 'ojas', machineName: 'ojas-mbp' },
    fetcher,
    storePath,
  })

  assert.deepEqual(summary.added, ['d@example.com'])
  assert.equal(summary.total, 4)
  assert.equal(summary.synced, 3)
  assert.deepEqual(summary.results.map((r) => [r.email, r.ok]), [['a@example.com', true], ['b@example.com', true], ['c@example.com', false], ['d@example.com', true]])
  assert.match(summary.results[2].reason, /sign-in expired/)
  assert.equal(posts.length, 3)
  assert.ok(posts.every((p) => p.deviceToken === 'device-token' && p.device.label === 'ojas' && p.rateLimits.rateLimitsByLimitId.codex))
  assert.deepEqual(posts.map((p) => p.accountState.account.email), ['a@example.com', 'b@example.com', 'd@example.com'])

  const saved = JSON.parse(await readFile(storePath, 'utf8'))
  assert.equal(saved.accounts.find((a) => a.email === 'b@example.com').auth_data.access_token, 'access-acc-b-new', 'the refreshed token is persisted')
  assert.equal(saved.accounts.find((a) => a.email === 'b@example.com').auth_data.refresh_token, 'refresh-acc-b-new')
  assert.ok(saved.accounts.some((a) => a.email === 'd@example.com'), 'the active login joins the store')
  assert.equal(statSync(storePath).mode & 0o777, 0o600)
})

test('a usage request that fails after a refresh is a skip, never a crash', async () => {
  const fetcher = async (url) => (url.endsWith('/oauth/token') ? { ok: true, status: 200, json: async () => ({ access_token: 'x' }) } : { ok: false, status: 401, json: async () => ({}) })
  const result = await fetchUsage({ account_id: 'a', access_token: 'old', refresh_token: 'r' }, fetcher)
  assert.match(result.error, /HTTP 401/)
})

test('a missing store reads as empty instead of failing', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-sync-all-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  assert.deepEqual((await readStore(path.join(dir, 'none.json'))).accounts, [])
})
