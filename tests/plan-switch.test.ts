import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  PLAN_SWITCH_PENDING_MAX_AGE_MS,
  PLAN_SWITCH_RESULT_MAX_AGE_MS,
  readPlanSwitchState,
  withActiveReport,
  withSwitchRequest,
  withSwitchResult,
} from '../api/_lib/login/switch-state.ts'
import {
  pendingSwitchFromPoll,
  readActiveEmail,
  readSwitchboardEndpoint,
  runPlanSwitchPass,
  switchThroughSwitchboard,
} from '../bin/lib/plan-switch.js'
import { planSwitchTarget, PLAN_SWITCH_ACTIVE_MAX_AGE_MS } from '../src/features/dashboard/plan-switch-state'

const at = '2026-09-19T10:00:00.000Z'
const later = (ms: number) => new Date(Date.parse(at) + ms).toISOString()

test('a click becomes one pending request per machine and expires instead of replaying', () => {
  const requested = withSwitchRequest({ other: 1 }, 'Pro@X.com', 'req-1', at)
  assert.equal(requested.reason, null)
  assert.deepEqual(requested.pending, { email: 'pro@x.com', requestId: 'req-1', requestedAt: at })
  assert.equal((requested.metadata as { other?: number }).other, 1, 'other metadata survives')

  const again = withSwitchRequest(requested.metadata, 'pro@x.com', 'req-2', later(1000))
  assert.equal(again.reason, 'duplicate')
  assert.equal(again.pending?.requestId, 'req-1', 'the first click keeps its id')

  const other = withSwitchRequest(requested.metadata, 'team@x.com', 'req-3', later(1000))
  assert.equal(other.reason, 'busy')
  assert.equal(readPlanSwitchState(other.metadata, Date.parse(at)).pending?.email, 'pro@x.com')

  const stale = readPlanSwitchState(requested.metadata, Date.parse(at) + PLAN_SWITCH_PENDING_MAX_AGE_MS + 1)
  assert.equal(stale.pending, null, 'an unclaimed click never switches hours later')
  assert.equal(withSwitchRequest({}, 'nope', 'req-4', at).reason, 'invalid-email')
})

test('the active login is refused as a target and a successful switch becomes the active login', () => {
  const active = withActiveReport({}, 'PRO@x.com', at)
  assert.deepEqual(readPlanSwitchState(active).active, { email: 'pro@x.com', reportedAt: at })
  assert.equal(withSwitchRequest(active, 'pro@x.com', 'req-1', at).reason, 'already-active')

  const requested = withSwitchRequest(active, 'team@x.com', 'req-1', at)
  const done = withSwitchResult(requested.metadata, { email: 'team@x.com', outcome: 'switched', requestId: 'req-1' }, later(5000))
  const state = readPlanSwitchState(done, Date.parse(at) + 5000)
  assert.equal(state.pending, null)
  assert.equal(state.active?.email, 'team@x.com')
  assert.equal(state.lastResult?.outcome, 'switched')

  const gone = readPlanSwitchState(done, Date.parse(at) + 5000 + PLAN_SWITCH_RESULT_MAX_AGE_MS + 1)
  assert.equal(gone.lastResult, null, 'an old outcome stops decorating the row')
  assert.equal(gone.active?.email, 'team@x.com', 'the active login has no expiry of its own')
})

test('a failed switch clears its own request, keeps the active login, and never clears a newer request', () => {
  const requested = withSwitchRequest(withActiveReport({}, 'pro@x.com', at), 'team@x.com', 'req-1', at)
  const failed = withSwitchResult(
    requested.metadata,
    { detail: 'Codex has active tasks. Switch when they finish.', email: 'team@x.com', outcome: 'failed', requestId: 'req-1' },
    later(2000),
  )
  const state = readPlanSwitchState(failed, Date.parse(at) + 2000)
  assert.equal(state.pending, null)
  assert.equal(state.active?.email, 'pro@x.com')
  assert.equal(state.lastResult?.detail, 'Codex has active tasks. Switch when they finish.')

  const newer = withSwitchRequest(failed, 'team@x.com', 'req-2', later(3000))
  const lateReport = withSwitchResult(newer.metadata, { email: 'team@x.com', outcome: 'failed', requestId: 'req-1' }, later(4000))
  assert.equal(readPlanSwitchState(lateReport, Date.parse(at) + 4000).pending?.requestId, 'req-2')
})

test('the dashboard picks the freshest machine that reports an active login', () => {
  const now = Date.parse(at)
  const device = (id: string, active: { email: string; reportedAt: string } | null) => ({
    active,
    id,
    label: id,
    lastResult: null,
    lastSeenAt: at,
    machineName: null,
    pending: null,
  })
  assert.equal(planSwitchTarget(undefined, now), null)
  assert.equal(planSwitchTarget([device('store-only', null)], now), null, 'a store-only syncer is never a switch target')
  const stale = device('stale', { email: 'a@x.com', reportedAt: new Date(now - PLAN_SWITCH_ACTIVE_MAX_AGE_MS - 1).toISOString() })
  const fresh = device('fresh', { email: 'b@x.com', reportedAt: at })
  assert.equal(planSwitchTarget([stale, fresh], now)?.id, 'fresh')
})

const jwt = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`

test('the agent reads the active login from auth.json and the pending request from a poll', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'plan-switch-home-'))
  try {
    assert.equal(readActiveEmail(home), null)
    await writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: jwt({ email: 'Pro@X.com' }), access_token: 'x', refresh_token: 'y', account_id: 'acct' } }),
    )
    assert.equal(readActiveEmail(home), 'pro@x.com')
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk' }))
    assert.equal(readActiveEmail(home), null, 'an API-key login is not a plan')
  } finally {
    await rm(home, { force: true, recursive: true })
  }
  assert.equal(pendingSwitchFromPoll({ pending: null }), null)
  assert.equal(pendingSwitchFromPoll({ pending: { email: 'a@x.com' } }), null, 'a request without an id is ignored')
  assert.deepEqual(pendingSwitchFromPoll({ pending: { email: 'A@x.com', requestId: 'r' } }), { email: 'a@x.com', requestId: 'r' })
})

test('the switch goes through the running Switchboard by store account id', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'plan-switch-state-'))
  const storePath = path.join(stateDir, 'accounts.json')
  try {
    assert.equal(readSwitchboardEndpoint(stateDir), null, 'no dashboard.json means no Switchboard')
    await writeFile(path.join(stateDir, 'dashboard.json'), JSON.stringify({ origin: 'http://127.0.0.1:3211', pid: process.pid }))
    await writeFile(path.join(stateDir, 'dashboard-key.json'), JSON.stringify({ token: 'secret' }))
    assert.deepEqual(readSwitchboardEndpoint(stateDir), { origin: 'http://127.0.0.1:3211', token: 'secret' })
    await writeFile(path.join(stateDir, 'dashboard.json'), JSON.stringify({ origin: 'http://127.0.0.1:3211', pid: 2 ** 22 - 1 }))
    assert.equal(readSwitchboardEndpoint(stateDir), null, 'a dead Switchboard pid is not an endpoint')
    await writeFile(path.join(stateDir, 'dashboard.json'), JSON.stringify({ origin: 'http://127.0.0.1:3211', pid: process.pid }))

    await writeFile(storePath, JSON.stringify({ accounts: [{ id: 'acc-team', email: 'Team@x.com' }] }))
    const calls: { url: string; body: unknown; auth: string | undefined }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(String(init.body)), url })
      return new Response(JSON.stringify({ ok: true, email: 'team@x.com' }), { status: 200 })
    }) as unknown as typeof fetch

    const switched = await switchThroughSwitchboard({ email: 'team@x.com', fetcher, stateDir, storePath })
    assert.deepEqual(switched, { email: 'team@x.com' })
    assert.deepEqual(calls, [{ auth: 'Bearer secret', body: { id: 'acc-team' }, url: 'http://127.0.0.1:3211/api/switch' }])

    await assert.rejects(
      switchThroughSwitchboard({ email: 'unknown@x.com', fetcher, stateDir, storePath }),
      /No saved login for unknown@x.com/,
    )
    const refusing = (async () => new Response(JSON.stringify({ error: 'Codex has active tasks. Switch when they finish.' }), { status: 400 })) as unknown as typeof fetch
    await assert.rejects(
      switchThroughSwitchboard({ email: 'team@x.com', fetcher: refusing, stateDir, storePath }),
      /Codex has active tasks/,
    )
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('one pass reports the active login, runs the request, and reports the outcome', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'plan-switch-pass-'))
  try {
    await writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: jwt({ email: 'pro@x.com' }), access_token: 'x', refresh_token: 'y', account_id: 'acct' } }),
    )
    const config = { deviceToken: 'device-token', syncUrl: 'https://dash.example/api/sync' }
    const posted: { path: string; body: Record<string, unknown> }[] = []
    let pending: unknown = { email: 'team@x.com', requestId: 'req-1' }
    const fetcher = (async (url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posted.push({ body, path: url.pathname })
      if (url.pathname.endsWith('/poll')) return new Response(JSON.stringify({ pending }), { status: 200 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    const switchedTo: string[] = []
    const logs: string[] = []
    const switcher = async ({ email }: { email: string }) => {
      switchedTo.push(email)
      return { email }
    }

    assert.equal(await runPlanSwitchPass({ codexHome: home, config, fetcher, log: (m: string) => logs.push(m), switcher }), true)
    assert.deepEqual(switchedTo, ['team@x.com'])
    assert.deepEqual(posted.map((p) => p.path), ['/api/login/switch/poll', '/api/login/switch/done'])
    assert.equal(posted[0].body.activeEmail, 'pro@x.com')
    assert.equal(posted[0].body.deviceToken, 'device-token')
    assert.deepEqual(posted[1].body, { detail: null, deviceToken: 'device-token', email: 'team@x.com', outcome: 'switched', requestId: 'req-1' })

    posted.length = 0
    const failing = async () => {
      throw new Error('Codex Switchboard is not running on this machine; open it and try again.')
    }
    assert.equal(await runPlanSwitchPass({ codexHome: home, config, fetcher, log: (m: string) => logs.push(m), switcher: failing }), false)
    assert.equal(posted[1].body.outcome, 'failed')
    assert.match(String(posted[1].body.detail), /Switchboard is not running/)

    posted.length = 0
    pending = null
    assert.equal(await runPlanSwitchPass({ codexHome: home, config, fetcher, log: (m: string) => logs.push(m), switcher }), false)
    assert.deepEqual(posted.map((p) => p.path), ['/api/login/switch/poll'], 'nothing pending means only the active-login report')

    assert.equal(await runPlanSwitchPass({ codexHome: home, config: {}, fetcher, switcher }), false, 'an unpaired machine makes no request')
  } finally {
    await rm(home, { force: true, recursive: true })
  }
})
