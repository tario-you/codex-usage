import assert from 'node:assert/strict'
import test from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

const owner = '11111111-1111-4111-8111-111111111111'
const device = '22222222-2222-4222-8222-222222222222'
const account = '33333333-3333-4333-8333-333333333333'
const requestId = '44444444-4444-4444-8444-444444444444'
const { privateKey, publicKey } = await generateKeyPair('ES256')
process.env.SUPABASE_URL = 'https://browser-fixture.invalid'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-role'
process.env.SUPABASE_JWKS = JSON.stringify({ keys: [{ ...await exportJWK(publicKey), kid: 'browser-test' }] })
const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'browser-test' })
  .setIssuer('https://browser-fixture.invalid/auth/v1').setAudience('authenticated').setSubject(owner).setExpirationTime('1h').sign(privateKey)
const routes = await import('../api/_lib/login/browser.ts')
const originalFetch = globalThis.fetch
const request = (path = '', body, authenticated = true) => new Request(`https://dashboard.invalid/api/login/browser${path}`, {
  method: body ? 'POST' : 'GET', headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
})

async function mockDb(run, respond) {
  const calls = []
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    const call = { table: url.pathname.split('/').at(-1), query: url.searchParams, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null }
    calls.push(call)
    const rows = respond(call)
    const accept = new Headers(options.headers).get('accept') ?? ''
    return new Response(JSON.stringify(accept.includes('vnd.pgrst.object') ? rows[0] ?? null : rows), { headers: { 'content-type': 'application/json' } })
  }
  try { return { response: await run(), calls } } finally { globalThis.fetch = originalFetch }
}

test('unauthenticated launches are rejected before any database access', async () => {
  const { response, calls } = await mockDb(() => routes.POST(request('', { deviceId: device, accountId: account }, false)), () => { throw new Error('must not query') })
  assert.equal(response.status, 401)
  assert.equal(calls.length, 0)
})

test('owner click resolves provider and email server-side and scopes machine and account to the owner', async () => {
  const { response, calls } = await mockDb(() => routes.POST(request('', { deviceId: device, accountId: account, provider: 'codex', email: 'injected@example.com', loginMethod: 'google' })), call => {
    if (call.table === 'codex_accounts') return [{ id: account, email: 'fixture@example.com', account_key: 'claude:fixture@example.com' }]
    if (call.table === 'codex_devices') return [{ id: device }]
    if (call.method === 'POST') return [{ id: requestId }]
    return []
  })
  assert.equal(response.status, 200)
  for (const call of calls.filter(c => ['codex_accounts', 'codex_devices'].includes(c.table))) {
    assert.equal(call.query.get('owner_user_id'), `eq.${owner}`)
  }
  const machine = calls.find(c => c.table === 'codex_devices')
  assert.equal(machine.query.get('revoked_at'), 'is.null')
  assert.match(machine.query.get('browser_agent_seen_at'), /^gte\./)
  const inserted = calls.find(c => c.method === 'POST').body
  assert.equal(inserted.provider, 'claude')
  assert.equal(inserted.login_method, 'google')
  assert.equal(inserted.email, 'fixture@example.com')
  assert.equal(inserted.owner_user_id, owner)
})

test('a missing owned account or offline device cannot enqueue a launch', async () => {
  for (const missing of ['codex_accounts', 'codex_devices']) {
    const { response, calls } = await mockDb(() => routes.POST(request('', { deviceId: device, accountId: account })), call => {
      if (call.table === missing) return []
      if (call.table === 'codex_accounts') return [{ id: account, email: 'fixture@example.com', account_key: 'fixture' }]
      throw new Error('must not enqueue')
    })
    assert.ok([403, 409].includes(response.status))
    assert.ok(!calls.some(c => c.method === 'POST'))
  }
})

test('device poll claims only its live request and a competing claimant gets no launch', async () => {
  for (const claimWins of [true, false]) {
    const { response, calls } = await mockDb(() => routes.POLL(request('/poll', { deviceToken: 'fixture-device' }, false)), call => {
      if (call.table === 'codex_devices') return call.method === 'GET' ? [{ id: device, owner_user_id: owner }] : []
      if (call.method === 'GET') return [{ id: requestId }]
      return claimWins ? [{ id: requestId, provider: 'codex', email: 'fixture@example.com', login_method: 'google', expires_at: new Date(Date.now() + 60000).toISOString() }] : []
    })
    const payload = await response.json()
    assert.equal(Boolean(payload.pending), claimWins)
    if (claimWins) assert.equal(payload.pending.login_method, 'google')
    const selected = calls.find(c => c.table === 'codex_browser_launches' && c.method === 'GET')
    assert.equal(selected.query.get('device_id'), `eq.${device}`)
    assert.equal(selected.query.get('owner_user_id'), `eq.${owner}`)
    assert.equal(selected.query.get('state'), 'eq.queued')
    assert.match(selected.query.get('expires_at'), /^gt\./)
    const claim = calls.find(c => c.table === 'codex_browser_launches' && c.method === 'PATCH')
    assert.equal(claim.query.get('state'), 'eq.queued')
    assert.equal(claim.query.get('id'), `eq.${requestId}`)
    assert.equal(claim.body.state, 'opening')
    assert.ok(claim.query.get('select').split(',').includes('login_method'))
  }
})

test('request receipts and results cannot cross account owners or machines', async () => {
  const receipt = await mockDb(() => routes.GET(request(`?requestId=${requestId}`)), () => [{ id: requestId, state: 'queued', expires_at: new Date(0).toISOString() }])
  assert.equal((await receipt.response.json()).state, 'expired')
  assert.equal(receipt.calls[0].query.get('owner_user_id'), `eq.${owner}`)
  const done = await mockDb(() => routes.DONE(request('/done', { deviceToken: 'fixture-device', requestId, outcome: 'opened' }, false)), call => call.table === 'codex_devices' ? [{ id: device, owner_user_id: owner }] : [])
  const update = done.calls.at(-1)
  assert.equal(update.query.get('device_id'), `eq.${device}`)
  assert.equal(update.query.get('owner_user_id'), `eq.${owner}`)
  assert.equal(update.query.get('id'), `eq.${requestId}`)
  assert.equal(update.query.get('state'), 'eq.opening')
})


test('unsupported login methods are rejected before database access', async () => {
  const { response, calls } = await mockDb(() => routes.POST(request('', { deviceId: device, accountId: account, loginMethod: 'evil' })), () => { throw new Error('must not query') })
  assert.equal(response.status, 400)
  assert.equal(calls.length, 0)
})
