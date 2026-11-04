import assert from 'node:assert/strict'
import test from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { hashToken } from '../api/_lib/security'

const owner = '11111111-1111-4111-8111-111111111111'
const deviceToken = 'device-token-fixture'
const deviceKey = 'device_fixture'
const { privateKey, publicKey } = await generateKeyPair('ES256')
process.env.SUPABASE_URL = 'https://unlink-fixture.invalid'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-role'
process.env.SUPABASE_JWKS = JSON.stringify({ keys: [{ ...await exportJWK(publicKey), kid: 'unlink-test' }] })
const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'unlink-test' })
  .setIssuer('https://unlink-fixture.invalid/auth/v1').setAudience('authenticated').setSubject(owner).setExpirationTime('1h').sign(privateKey)
const unlink = await import('../api/accounts/unlink.ts')
const sync = await import('../api/sync.ts')
const { persistSnapshotForOwner } = await import('../api/_lib/persistence.ts')

const window = { resetsAt: null, usedPercent: 10, windowDurationMins: 10080 }
const rateLimits = {
  rateLimits: { credits: null, limitId: null, limitName: null, planType: 'pro', primary: window, secondary: null },
  rateLimitsByLimitId: null,
}
const accountState = (type, email) => ({ account: { email, planType: 'pro', type }, requiresOpenaiAuth: false })

/** A tiny in-memory PostgREST: eq/is filters, upsert on_conflict, single-object reads. */
function fakeSupabase(tables) {
  let nextId = 100
  const matches = (row, params) => [...params].every(([field, value]) => {
    if (['select', 'on_conflict', 'columns'].includes(field)) return true
    if (value === 'is.null') return row[field] == null
    if (value.startsWith('eq.')) return String(row[field]) === value.slice(3)
    if (value.startsWith('lt.')) return row[field] != null && Date.parse(row[field]) < Date.parse(value.slice(3))
    if (value.startsWith('gte.')) return row[field] != null && Date.parse(row[field]) >= Date.parse(value.slice(4))
    if (value.startsWith('in.(')) return value.slice(4, -1).split(',').map(v => v.replace(/"/g, '')).includes(String(row[field]))
    throw new Error(`unsupported filter ${field}=${value}`)
  })
  return async (input, options = {}) => {
    const url = new URL(String(input))
    assert.equal(url.hostname, 'unlink-fixture.invalid')
    const table = url.pathname.replace('/rest/v1/', '')
    const rows = (tables[table] ??= [])
    const method = options.method ?? 'GET'
    let result
    if (method === 'GET') {
      result = rows.filter(row => matches(row, url.searchParams))
    } else if (method === 'POST') {
      const conflict = url.searchParams.get('on_conflict')?.split(',') ?? []
      const incoming = [JSON.parse(options.body)].flat()
      result = incoming.map(row => {
        const existing = conflict.length ? rows.find(other => conflict.every(field => other[field] === row[field])) : null
        if (existing) return Object.assign(existing, row)
        const created = { id: String(nextId++), ...row }
        rows.push(created)
        return created
      })
    } else if (method === 'PATCH') {
      result = rows.filter(row => matches(row, url.searchParams)).map(row => Object.assign(row, JSON.parse(options.body)))
    } else if (method === 'DELETE') {
      result = rows.filter(row => matches(row, url.searchParams))
      tables[table] = rows.filter(row => !result.includes(row))
    }
    const accept = new Headers(options.headers).get('accept') ?? ''
    if (accept.includes('vnd.pgrst.object')) {
      if (result.length !== 1) {
        return new Response(JSON.stringify({ code: 'PGRST116', message: 'no rows', details: '', hint: '' }), { status: 406, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(result[0]), { headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } })
  }
}

const post = (handler, body, authenticated = false) => handler(new Request('https://dashboard.invalid/api', {
  method: 'POST',
  headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
  body: JSON.stringify(body),
}))

test('unlinking one account keeps the machine syncing every other plan and stays unlinked until relinked', async () => {
  const originalFetch = globalThis.fetch
  const tables = {
    codex_devices: [{ id: 'device-1', owner_user_id: owner, device_key: deviceKey, device_token_hash: hashToken(deviceToken), label: 'mac', machine_name: 'mac', codex_home: null, metadata: {}, revoked_at: null }],
    codex_accounts: [
      { id: 'codex-row', owner_user_id: owner, account_key: 'chatgpt:kept@example.com', source_key: deviceKey },
      { id: 'claude-row', owner_user_id: owner, account_key: 'claude:gone@example.com', source_key: deviceKey },
    ],
  }
  globalThis.fetch = fakeSupabase(tables)
  try {
    const unlinked = await post(unlink.POST, { accountId: '00000000-0000-4000-8000-000000000001' }, true)
    assert.equal(unlinked.status, 404, 'an unknown account is refused')
    tables.codex_accounts[1].id = '00000000-0000-4000-8000-000000000002'
    const response = await post(unlink.POST, { accountId: '00000000-0000-4000-8000-000000000002' }, true)
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(tables.codex_devices[0].revoked_at, null, 'the machine that reported the account stays authorized')
    assert.deepEqual(tables.codex_accounts.map(row => row.account_key), ['chatgpt:kept@example.com'])
    assert.deepEqual(tables.codex_unlinked_accounts.map(row => [row.owner_user_id, row.account_key]), [[owner, 'claude:gone@example.com']])

    const kept = await post(sync.POST, { accountState: accountState('chatgpt', 'kept@example.com'), deviceToken, rateLimits })
    assert.equal(kept.status, 200, await kept.clone().text())
    assert.equal((await kept.json()).unlinked, undefined)

    const skipped = await post(sync.POST, { accountState: accountState('claude', 'Gone@Example.com'), deviceToken, rateLimits })
    assert.equal(skipped.status, 200, await skipped.clone().text())
    assert.equal((await skipped.json()).unlinked, true)
    assert.deepEqual(tables.codex_accounts.map(row => row.account_key), ['chatgpt:kept@example.com'], 'a background sync does not bring the unlinked account back')

    await persistSnapshotForOwner({
      accountState: accountState('claude', 'gone@example.com'),
      device: { codexHome: null, deviceId: 'device-1', deviceKey, label: 'mac', machineName: 'mac' },
      ownerUserId: owner,
      rateLimits,
      relink: true,
    })
    assert.deepEqual(tables.codex_accounts.map(row => row.account_key).sort(), ['chatgpt:kept@example.com', 'claude:gone@example.com'])
    assert.deepEqual(tables.codex_unlinked_accounts, [], 'an explicit link clears the unlink')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// An account read only through the Claude app gets its reading from claude-auto-switch, hours after it was made: it
// carries its own time, and a reading no newer than the row's (the other uploader posting the same one) changes nothing.
test('a reading made earlier goes up dated when it was made, and never replaces a newer one', async () => {
  const originalFetch = globalThis.fetch
  const tables = {
    codex_devices: [{ id: 'device-1', owner_user_id: owner, device_key: deviceKey, device_token_hash: hashToken(deviceToken), label: 'mac', machine_name: 'mac', codex_home: null, metadata: {}, revoked_at: null }],
    codex_accounts: [{ id: 'team-row', owner_user_id: owner, account_key: 'claude:team@example.com', plan_type: 'max', last_snapshot_at: '2026-10-12T18:22:46.000Z' }],
  }
  const app = { rateLimits: { ...rateLimits.rateLimits, planType: null }, rateLimitsByLimitId: null }
  const team = { account: { email: 'team@example.com', type: 'claude' }, requiresOpenaiAuth: false }
  globalThis.fetch = fakeSupabase(tables)
  try {
    const readAt = Date.parse('2026-10-14T21:24:26.000Z')
    const newer = await post(sync.POST, { accountState: team, deviceToken, rateLimits: app, readAt })
    assert.equal(newer.status, 200, await newer.clone().text())
    assert.equal(tables.codex_accounts[0].last_snapshot_at, '2026-10-14T21:24:26.000Z')
    assert.equal(tables.codex_accounts[0].plan_type, 'max', 'a reading that never saw the plan leaves it')
    assert.deepEqual(tables.codex_usage_snapshots.map(row => row.fetched_at), ['2026-10-14T21:24:26.000Z'])

    const again = await post(sync.POST, { accountState: team, deviceToken, rateLimits: app, readAt })
    assert.equal((await again.json()).older, true)
    assert.equal(tables.codex_usage_snapshots.length, 1, 'the same reading twice is one snapshot')

    // The same reading with the agent's pool mark keeps the mark current, and still adds no snapshot.
    const idle = { account: { ...team.account, autoSwitch: { inPool: true, idle: true } }, requiresOpenaiAuth: false }
    const vouched = await post(sync.POST, { accountState: idle, deviceToken, rateLimits: app, readAt })
    assert.equal((await vouched.json()).older, true)
    assert.equal(tables.codex_usage_snapshots.length, 1)
    const mark = tables.codex_accounts[0].metadata.auto_switch
    assert.deepEqual([mark.in_pool, mark.idle, mark.machine], [true, true, 'mac'])
    assert.ok(Date.now() - Date.parse(mark.checked_at) < 60_000, 'checked now, not when the reading was made')
    assert.equal(tables.codex_accounts[0].last_snapshot_at, '2026-10-14T21:24:26.000Z', 'the reading keeps its own time')

    const future = await post(sync.POST, { accountState: team, deviceToken, rateLimits: app, readAt: Date.now() + 3_600_000 })
    assert.equal(future.status, 200)
    assert.ok(Date.parse(tables.codex_accounts[0].last_snapshot_at) <= Date.now(), 'a clock ahead never dates a row in the future')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// A plan's end date is typed by hand; a renewed Max plan kept reading "ended" with live readings coming in.
test('a paid reading after the typed end date clears it; a future date or an unnamed plan keeps it', async () => {
  const originalFetch = globalThis.fetch
  const device = { codexHome: null, deviceId: 'device-1', deviceKey, label: 'mac', machineName: 'mac' }
  const tables = {
    codex_accounts: [
      { id: 'renewed', owner_user_id: owner, account_key: 'claude:renewed@example.com', plan_ends_at: '2026-10-18T07:00:00+00:00' },
      { id: 'ending', owner_user_id: owner, account_key: 'claude:ending@example.com', plan_ends_at: '2099-01-01T00:00:00+00:00' },
      { id: 'unknown', owner_user_id: owner, account_key: 'claude:unknown@example.com', plan_ends_at: '2026-10-18T07:00:00+00:00' },
    ],
  }
  const max = { rateLimits: { ...rateLimits.rateLimits, planType: 'max' }, rateLimitsByLimitId: null }
  const unnamed = { rateLimits: { ...rateLimits.rateLimits, planType: null }, rateLimitsByLimitId: null }
  const claude = email => ({ account: { email, type: 'claude' }, requiresOpenaiAuth: false })
  globalThis.fetch = fakeSupabase(tables)
  try {
    await persistSnapshotForOwner({ accountState: claude('renewed@example.com'), device, ownerUserId: owner, rateLimits: max })
    await persistSnapshotForOwner({ accountState: claude('ending@example.com'), device, ownerUserId: owner, rateLimits: max })
    await persistSnapshotForOwner({ accountState: claude('unknown@example.com'), device, ownerUserId: owner, rateLimits: unnamed })
    const ends = Object.fromEntries(tables.codex_accounts.map(row => [row.id, row.plan_ends_at]))
    assert.equal(ends.renewed, null, 'the provider still serving Max after the date is the renewal')
    assert.equal(ends.ending, '2099-01-01T00:00:00+00:00', 'a date still ahead stays')
    assert.equal(ends.unknown, '2026-10-18T07:00:00+00:00', 'a reading that names no plan proves nothing')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// 11-05: tgyou168 and electricfan244 read signed out from a dead saved login while the app still read both.
test('a real reading replaces signed-out marks made after it', async () => {
  const originalFetch = globalThis.fetch
  const tables = {
    codex_devices: [{ id: 'device-1', owner_user_id: owner, device_key: deviceKey, device_token_hash: hashToken(deviceToken), label: 'mac', machine_name: 'mac', codex_home: null, metadata: {}, revoked_at: null }],
    codex_accounts: [{ id: 'fan-row', owner_user_id: owner, account_key: 'claude:fan@example.com', plan_type: 'max', last_snapshot_at: '2026-11-04T18:30:00.000Z' }],
    codex_usage_snapshots: [{ id: 's1', account_id: 'fan-row', fetched_at: '2026-11-04T18:30:00.000Z', raw_rate_limits: { connection: { status: 'needs-login' } } }],
  }
  const app = { rateLimits: { ...rateLimits.rateLimits, planType: null }, rateLimitsByLimitId: null }
  const fan = { account: { email: 'fan@example.com', type: 'claude' }, requiresOpenaiAuth: false }
  globalThis.fetch = fakeSupabase(tables)
  try {
    const res = await post(sync.POST, { accountState: fan, deviceToken, rateLimits: app, readAt: Date.parse('2026-11-04T16:56:00.000Z') })
    assert.equal(res.status, 200, await res.clone().text())
    assert.deepEqual(tables.codex_usage_snapshots.map(row => row.fetched_at), ['2026-11-04T16:56:00.000Z'])
  } finally {
    globalThis.fetch = originalFetch
  }
})
