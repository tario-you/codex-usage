import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { rateLimitsSchema } from '../api/_lib/schemas.ts'
import {
  RESET_CONSUME_URL,
  consumeResetCredit,
  planResetSpend,
  resetCreditTarget,
  resetPlanFromUsage,
} from '../bin/lib/reset-credits.js'
import { buildSyncPayloadFromUsage, resetSpendingOwnedElsewhere, syncAllOnce, upsertStoreAccount } from '../bin/lib/sync-all.js'
import { resetCreditChoice } from '../src/features/dashboard/reset-credit-choice.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 24)
const out = (id, returnsInMs, { planType = 'pro', credits = 1, cancelled = false, endsInMs = null } = {}) => ({
  cancelled,
  credits,
  endsAt: endsInMs == null ? null : NOW + endsInMs,
  exhausted: true,
  id,
  planType,
  returnsAt: NOW + returnsInMs,
})
const pick = (plans) => resetCreditTarget(plans, { now: NOW })?.plan.id ?? null

test('a reset goes to the plan whose own reset is furthest away, weighted by plan size', () => {
  assert.equal(pick([out('soon', 2 * DAY), out('late', 6.8 * DAY)]), 'late', 'same plan: the longest wait first')
  assert.equal(pick([out('lite', 6.2 * DAY, { planType: 'prolite' }), out('pro', 2.8 * DAY)]), 'pro', 'a Pro Lite holds a quarter of a Pro')
  assert.equal(pick([out('lite', 6 * DAY, { planType: 'prolite' }), out('pro', DAY)]), 'lite', 'a Pro Lite wins once its wait is over four times longer')
  assert.equal(pick([{ ...out('open', 6 * DAY), exhausted: false }, out('none', 6 * DAY, { credits: 0 }), out('soon', DAY)]), 'soon', 'only plans that are out and hold a credit count')
  assert.equal(pick([out('none', 6 * DAY, { credits: 0 })]), null)
})

test('a cancelled plan that ends before its own reset spends its last-chance credit first', () => {
  assert.equal(pick([out('pro', 6.8 * DAY), out('ending', 6 * DAY, { planType: 'prolite', cancelled: true, endsInMs: 3 * DAY })]), 'ending')
  assert.equal(pick([out('pro', 2.8 * DAY), out('returns', 2 * DAY, { planType: 'prolite', cancelled: true, endsInMs: 16 * DAY })]), 'pro', 'a cancelled plan that comes back first is scored like any other')
  assert.equal(pick([out('pro', 2.8 * DAY), out('renews', 6 * DAY, { planType: 'prolite', endsInMs: DAY })]), 'pro', 'an end date alone is a renewal')
  assert.equal(pick([out('pro', 2.8 * DAY), out('gone', 6 * DAY, { planType: 'prolite', cancelled: true, endsInMs: -DAY })]), 'pro', 'a plan that already ended is no last chance')
})

test('a credit is spent only once every plan is out', () => {
  assert.deepEqual(planResetSpend([{ ...out('open', DAY), exhausted: false }, out('late', 6 * DAY)], { now: NOW }).reason, 'usage-left')
  const decision = planResetSpend([out('soon', 2 * DAY), out('late', 6 * DAY)], { now: NOW })
  assert.equal(decision.action, 'spend'); assert.equal(decision.plan.id, 'late'); assert.equal(decision.savedMs, 6 * DAY)
  assert.equal(planResetSpend([out('none', DAY, { credits: 0 })], { now: NOW }).reason, 'no-credits')
})

test('the usage response and the store entry become the chooser input', () => {
  const body = { plan_type: 'prolite', rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 40, reset_at: 100 }, secondary_window: { used_percent: 100, reset_at: 900 } }, rate_limit_reset_credits: { available_count: 2, applicable_available_count: 1 } }
  const plan = resetPlanFromUsage('a', body, { subscription_cancelled: true, subscription_expires_at: '2026-10-16T08:31:57+00:00' })
  assert.deepEqual(plan, { cancelled: true, credits: 1, endsAt: Date.parse('2026-10-16T08:31:57+00:00'), exhausted: true, id: 'a', planType: 'prolite', returnsAt: 900_000 })
  const open = resetPlanFromUsage('b', { rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 15, reset_at: 5 } }, rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 } })
  assert.equal(open.exhausted, false); assert.equal(open.returnsAt, null); assert.equal(open.credits, 0)
})

test('spending sends the request the Codex app sends and reads every outcome', async () => {
  const seen = []
  const answer = (code, ok = true) => async (url, options) => { seen.push({ url, options }); return { ok, status: ok ? 200 : 500, json: async () => ({ code }) } }
  assert.deepEqual(await consumeResetCredit({ access_token: 't', account_id: 'acct' }, { fetcher: answer('reset'), redeemRequestId: 'key-1' }), { outcome: 'reset' })
  assert.equal(seen[0].url, RESET_CONSUME_URL); assert.equal(seen[0].options.method, 'POST')
  assert.equal(seen[0].options.headers.Authorization, 'Bearer t'); assert.equal(seen[0].options.headers['ChatGPT-Account-Id'], 'acct')
  assert.deepEqual(JSON.parse(seen[0].options.body), { redeem_request_id: 'key-1' })
  for (const [code, outcome] of [['nothing_to_reset', 'nothingToReset'], ['no_credit', 'noCredit'], ['already_redeemed', 'alreadyRedeemed']]) {
    assert.equal((await consumeResetCredit({ access_token: 't', account_id: 'a' }, { fetcher: answer(code) })).outcome, outcome)
  }
  assert.match((await consumeResetCredit({ access_token: 't', account_id: 'a' }, { fetcher: answer(null, false) })).error, /HTTP 500/)
})

test('the dashboard names the same plan the agent would reset', () => {
  const iso = (ms) => new Date(NOW + ms).toISOString()
  const row = (id, plan, resetsInMs, extra = {}) => ({ account_key: `chatgpt:${id}`, email: `${id}@x.com`, id, label: id, plan_type: plan, primary_resets_at: iso(resetsInMs), primary_used_percent: 100, raw_rate_limits: { resetCredits: { applicable: 1, available: 1 }, ...extra }, secondary_resets_at: null, secondary_used_percent: null })
  const rows = [row('geoff', 'pro', 2.8 * DAY), row('lite', 'prolite', 6.2 * DAY), row('claude', 'max', 6.9 * DAY, {})]
  rows[2].account_key = 'claude:claude@x.com'
  assert.equal(resetCreditChoice(rows, NOW).accountLabel, 'geoff')
  assert.equal(resetCreditChoice([...rows, row('ending', 'prolite', 6 * DAY, { subscription: { cancelled: true, endsAt: Math.round((NOW + 3 * DAY) / 1000) } })], NOW).accountLabel, 'ending')
  assert.equal(resetCreditChoice([row('past', 'pro', -DAY)], NOW), null, 'a window whose reset has passed is back')
})

test('the cancelled flag and end ride the sync payload through the schema', () => {
  const body = { plan_type: 'prolite', rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 5 } }, rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 } }
  const payload = buildSyncPayloadFromUsage(body, 'a@x.com', { subscription_cancelled: true, subscription_expires_at: '2026-10-16T08:31:57+00:00' })
  assert.deepEqual(rateLimitsSchema.parse(payload.rateLimits).rateLimits.subscription, { cancelled: true, endsAt: Math.round(Date.parse('2026-10-16T08:31:57+00:00') / 1000) })
  assert.equal(rateLimitsSchema.parse(buildSyncPayloadFromUsage(body, 'a@x.com').rateLimits).rateLimits.subscription, undefined)
})

const jwt = (email) => `e30.${Buffer.from(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })).toString('base64url')}.sig`
const login = (id) => ({ OPENAI_API_KEY: null, auth_mode: 'chatgpt', last_refresh: '2026-09-24T00:00:00.000Z', tokens: { account_id: id, id_token: jwt(`${id}@x.com`), access_token: `access-${id}`, refresh_token: `refresh-${id}` } })

async function spendFixture(t, usedById) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-reset-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const storePath = path.join(dir, 'accounts.json')
  const store = { version: 1, accounts: [] }
  for (const id of Object.keys(usedById)) upsertStoreAccount(store, login(id))
  await writeFile(storePath, JSON.stringify(store))
  const consumed = [], posts = []
  const resetInDays = { soon: 2, late: 6, open: 3 }
  const fetcher = async (url, options = {}) => {
    const id = options.headers?.['ChatGPT-Account-Id']
    if (url === 'https://chatgpt.com/backend-api/wham/usage') {
      const used = usedById[id]
      return { ok: true, status: 200, json: async () => ({ plan_type: 'pro', rate_limit: { allowed: used < 100, limit_reached: used >= 100, primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: Math.round((NOW + resetInDays[id] * DAY) / 1000) } }, rate_limit_reset_credits: { available_count: 1, applicable_available_count: used >= 100 ? 1 : 0 } }) }
    }
    if (url === RESET_CONSUME_URL) { consumed.push(id); usedById[id] = 0; return { ok: true, status: 200, json: async () => ({ code: 'reset' }) } }
    if (url === 'https://dashboard.test/api/sync') { posts.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({}) } }
    throw new Error(`unexpected ${url}`)
  }
  const run = (extra = {}) => syncAllOnce({ config: { deviceToken: 'd', syncUrl: 'https://dashboard.test/api/sync' }, device: { label: 'mac' }, fetcher, now: NOW, spendResets: true, storePath, ...extra })
  return { consumed, posts, run }
}

test('sync --all --spend-resets resets the plan that waits longest once every plan is out, then reports it back', async (t) => {
  const { consumed, posts, run } = await spendFixture(t, { soon: 100, late: 100 })
  const summary = await run()
  assert.deepEqual(consumed, ['late'])
  assert.equal(summary.resetSpend.outcome, 'reset'); assert.equal(summary.resetSpend.usableAfter, true); assert.equal(summary.resetSpend.savedMs, 6 * DAY)
  assert.equal(posts.length, 3, 'both plans, then the reset plan again')
  const again = await run({ resetHoldUntil: NOW + 1 })
  assert.deepEqual(consumed, ['late'], 'the reset plan has usage now, so nothing more is spent')
  assert.equal(again.resetSpend.reason, 'usage-left')
})

test('no credit is spent while a plan has usage, during the cooldown, or without --spend-resets', async (t) => {
  const withUsage = await spendFixture(t, { soon: 100, open: 40 })
  assert.equal((await withUsage.run()).resetSpend.reason, 'usage-left'); assert.deepEqual(withUsage.consumed, [])
  const cooling = await spendFixture(t, { soon: 100, late: 100 })
  assert.equal((await cooling.run({ resetHoldUntil: NOW + 60_000 })).resetSpend.reason, 'cooldown'); assert.deepEqual(cooling.consumed, [])
  const off = await spendFixture(t, { soon: 100, late: 100 })
  assert.equal((await off.run({ spendResets: false })).resetSpend, null); assert.deepEqual(off.consumed, [])
})

test('the agent stands down where the Moonshot auto-switch spends resets', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-owner-'))
  t.after(() => rm(home, { force: true, recursive: true }))
  assert.equal(resetSpendingOwnedElsewhere({ home }), false)
  const state = path.join(home, '.local/state/codex-auto-switch'); mkdirSync(state, { recursive: true })
  const bin = path.join(home, 'codex-auto-switch'); writeFileSync(bin, '#!/bin/sh\n')
  writeFileSync(path.join(state, 'installation.json'), JSON.stringify({ enabled: true, bin }))
  assert.equal(resetSpendingOwnedElsewhere({ home }), true)
  writeFileSync(path.join(state, 'installation.json'), JSON.stringify({ enabled: false, bin }))
  assert.equal(resetSpendingOwnedElsewhere({ home }), false)
  writeFileSync(path.join(state, 'installation.json'), '{')
  assert.equal(resetSpendingOwnedElsewhere({ home }), true, 'an unreadable record stands down')
})
