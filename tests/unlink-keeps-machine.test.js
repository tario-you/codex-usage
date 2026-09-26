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
