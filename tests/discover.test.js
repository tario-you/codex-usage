import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  checkSavedLogins,
  discoverAccounts,
  emailsInJson,
  loginFromAuthFile,
  missingEmails,
  setupPlan,
} from '../bin/lib/discover.js'

const jwt = (email, plan = 'pro') =>
  `e30.${Buffer.from(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_account_id: `acct-${email}`, chatgpt_plan_type: plan } })).toString('base64url')}.sig`
const authFile = (email, lastRefresh, plan) => ({
  OPENAI_API_KEY: null,
  auth_mode: 'chatgpt',
  last_refresh: lastRefresh,
  tokens: { account_id: `acct-${email}`, id_token: jwt(email, plan), access_token: `access-${email}`, refresh_token: `refresh-${email}` },
})
const storeAccount = (email, extra = {}) => ({
  id: `store-${email}`,
  email,
  plan_type: 'pro',
  created_at: '2026-09-01T00:00:00.000Z',
  last_used_at: '2026-09-05T00:00:00.000Z',
  auth_data: { type: 'chat_g_p_t', account_id: `acct-${email}`, id_token: jwt(email), access_token: `access-${email}`, refresh_token: `refresh-${email}` },
  ...extra,
})

test('an auth file names its login, and a JSON walk finds every email with what sits beside it', () => {
  assert.deepEqual(loginFromAuthFile(authFile('A@X.com', '2026-09-10T00:00:00.000Z', 'prolite')), {
    accountId: 'acct-A@X.com',
    at: '2026-09-10T00:00:00.000Z',
    email: 'a@x.com',
    planType: 'prolite',
  })
  assert.equal(loginFromAuthFile({ tokens: { id_token: 'not-a-jwt' } }), null)
  assert.equal(loginFromAuthFile({ OPENAI_API_KEY: 'sk-x' }), null)
  const hits = emailsInJson({
    roster: [{ email: 'One@x.com', plan_type: 'pro', at: '2026-09-08T00:00:00.000Z' }, { name: 'no email here' }],
    nested: { deep: { email: 'two@x.com', accountId: 'acct-2' } },
    junk: { email: 'not an email' },
  })
  assert.deepEqual(hits, [
    { accountId: null, at: '2026-09-08T00:00:00.000Z', email: 'one@x.com', planType: 'pro' },
    { accountId: 'acct-2', at: null, email: 'two@x.com', planType: null },
  ])
})

test('discovery merges the current login, its backups, the store, Switchboard records, and the dashboard, one entry per email', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-discover-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const codexHome = path.join(root, 'codex')
  const stateDir = path.join(root, 'state')
  await mkdir(codexHome, { recursive: true })
  await mkdir(path.join(stateDir, 'removed'), { recursive: true })
  await writeFile(path.join(codexHome, 'auth.json'), JSON.stringify(authFile('current@x.com', '2026-09-10T12:00:00.000Z')))
  await writeFile(path.join(codexHome, 'auth.json.watchdog-bak-1'), JSON.stringify(authFile('earlier@x.com', '2026-09-09T12:00:00.000Z')))
  await writeFile(path.join(codexHome, 'auth.json.before-shared-login'), JSON.stringify(authFile('current@x.com', '2026-09-01T12:00:00.000Z')))
  await writeFile(path.join(codexHome, 'auth.json.broken'), '{not json')
  await writeFile(path.join(codexHome, 'codex-usage-sync.json'), JSON.stringify({ email: 'ignored-not-an-auth-file@x.com' }))
  const storePath = path.join(root, 'accounts.json')
  await writeFile(storePath, JSON.stringify({ version: 1, accounts: [storeAccount('current@x.com'), storeAccount('saved-only@x.com')] }))
  await writeFile(path.join(stateDir, 'result-abc.json'), JSON.stringify({ at: '2026-09-06T00:00:00.000Z', ok: true, email: 'Switched@x.com' }))
  await writeFile(path.join(stateDir, 'tray-status.json'), JSON.stringify({ accounts: [{ email: 'saved-only@x.com', remaining: 40, updatedAt: '2026-09-04T00:00:00.000Z' }] }))
  await writeFile(path.join(stateDir, 'login-progress.json'), JSON.stringify({ status: 'saved', email: 'progress@x.com' }))
  await writeFile(path.join(stateDir, 'removed', 'gone.json'), JSON.stringify({ email: 'forgotten@x.com' }))
  await writeFile(path.join(stateDir, 'notes.txt'), 'email: text-file@x.com')

  const candidates = await discoverAccounts({
    codexHome,
    storePath,
    stateDir,
    known: [
      { email: 'Dashboard@x.com', lastSeenAt: '2026-09-07T00:00:00.000Z', planType: 'plus', sourceLabel: 'other-mac', thisDevice: false },
      { email: 'current@x.com', lastSeenAt: '2026-09-10T13:00:00.000Z', sourceLabel: 'this-mac', thisDevice: true },
    ],
  })
  const byEmail = Object.fromEntries(candidates.map((candidate) => [candidate.email, candidate]))
  assert.deepEqual(Object.keys(byEmail).sort(), ['current@x.com', 'dashboard@x.com', 'earlier@x.com', 'progress@x.com', 'saved-only@x.com', 'switched@x.com'])
  assert.equal(candidates[0].email, 'progress@x.com', 'a record with no clock takes its file time, which is now')
  assert.equal(candidates[1].email, 'current@x.com', 'then the newest dated evidence')
  assert.deepEqual(candidates.slice(2).map((c) => c.email), ['earlier@x.com', 'dashboard@x.com', 'switched@x.com', 'saved-only@x.com'])
  assert.deepEqual(byEmail['current@x.com'].sources.map((source) => source.kind), [
    'current Codex login',
    'earlier Codex login',
    'saved login',
    'reported by this machine',
  ])
  assert.equal(byEmail['current@x.com'].lastSeenAt, '2026-09-10T13:00:00.000Z')
  assert.ok(byEmail['current@x.com'].saved, 'the store entry rides along')
  assert.equal(byEmail['earlier@x.com'].saved, null)
  assert.equal(byEmail['earlier@x.com'].accountId, 'acct-earlier@x.com')
  assert.deepEqual(byEmail['switched@x.com'].sources, [{ at: '2026-09-06T00:00:00.000Z', detail: 'result-abc.json', kind: 'Switchboard record' }])
  assert.equal(byEmail['dashboard@x.com'].planType, 'plus')
  assert.equal(byEmail['dashboard@x.com'].sources[0].kind, 'held on other-mac')
  assert.deepEqual(missingEmails(candidates).sort(), ['dashboard@x.com', 'earlier@x.com', 'progress@x.com', 'switched@x.com'])

  // Only saved logins hit the network; a 401 whose refresh is refused is expired.
  const calls = []
  const fetcher = async (url, init) => {
    calls.push(String(url))
    if (String(url).includes('/oauth/token')) return { ok: false, status: 400, json: async () => ({}) }
    const token = init.headers.Authorization
    if (token === 'Bearer access-saved-only@x.com') return { ok: false, status: 401, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: 37 } } }) }
  }
  const statuses = await checkSavedLogins(candidates, fetcher)
  assert.deepEqual(statuses.get('current@x.com'), { planType: 'pro', status: 'ok', usedPercent: 37 })
  assert.equal(statuses.get('saved-only@x.com').status, 'expired')
  assert.equal(statuses.get('earlier@x.com').status, 'missing')
  assert.equal(calls.filter((url) => url.includes('/wham/usage')).length, 2, 'two saved logins; a refused refresh gets no retry')

  assert.deepEqual(setupPlan(candidates, statuses), [
    { email: 'progress@x.com', why: 'never signed in here' },
    { email: 'earlier@x.com', why: 'never signed in here' },
    { email: 'dashboard@x.com', why: 'never signed in here' },
    { email: 'switched@x.com', why: 'never signed in here' },
    { email: 'saved-only@x.com', why: 'sign-in expired' },
  ])
})

test('discovery on an empty machine is empty, and a missing store or state dir is fine', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-discover-empty-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const candidates = await discoverAccounts({
    codexHome: path.join(root, 'nope'),
    storePath: path.join(root, 'nope', 'accounts.json'),
    stateDir: path.join(root, 'nope', 'state'),
  })
  assert.deepEqual(candidates, [])
  assert.deepEqual(setupPlan(candidates, new Map()), [])
})
