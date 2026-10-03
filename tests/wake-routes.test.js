import assert from 'node:assert/strict'
import test from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

const owner = '11111111-1111-4111-8111-111111111111'
const device = '22222222-2222-4222-8222-222222222222'
const otherDevice = '55555555-5555-4555-8555-555555555555'
const account = '33333333-3333-4333-8333-333333333333'
const launch = '44444444-4444-4444-8444-444444444444'
const { privateKey, publicKey } = await generateKeyPair('ES256')
process.env.SUPABASE_URL = 'https://wake-fixture.invalid'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-role'
process.env.VITE_SUPABASE_ANON_KEY = 'fixture-anon'
process.env.SUPABASE_JWKS = JSON.stringify({ keys: [{ ...await exportJWK(publicKey), kid: 'wake-test' }] })
const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'wake-test' })
  .setIssuer('https://wake-fixture.invalid/auth/v1').setAudience('authenticated').setSubject(owner).setExpirationTime('1h').sign(privateKey)
const browser = await import('../api/_lib/login/browser.ts')
const planSwitch = await import('../api/_lib/login/plan-switch.ts')
const repair = await import('../api/_lib/login/repair.ts')
const { AGENT_ONLINE_WINDOW_MS, wakeTopicFor } = await import('../api/_lib/wake.ts')
const originalFetch = globalThis.fetch

const request = (path, body, authenticated = true) => new Request(`https://dashboard.invalid${path}`, {
  method: body ? 'POST' : 'GET',
  headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
})

async function mockDb(run, respond = () => []) {
  const calls = []
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(options.headers)
    const call = { path: url.pathname, table: url.pathname.split('/').at(-1), query: url.searchParams, method: options.method ?? 'GET', headers, body: options.body ? JSON.parse(options.body) : null }
    calls.push(call)
    const rows = respond(call)
    return new Response(JSON.stringify((headers.get('accept') ?? '').includes('vnd.pgrst.object') ? rows[0] ?? null : rows), { headers: { 'content-type': 'application/json' } })
  }
  try { return { response: await run(), calls } } finally { globalThis.fetch = originalFetch }
}

const wakes = calls => calls.filter(call => call.path === '/realtime/v1/api/broadcast')

test('each machine gets its own unguessable wake topic', () => {
  assert.notEqual(wakeTopicFor(device), wakeTopicFor(otherDevice))
  assert.equal(wakeTopicFor(device), wakeTopicFor(device))
  assert.match(wakeTopicFor(device), /^wake-[a-f0-9]{40}$/)
  assert.ok(!wakeTopicFor(device).includes(device))
})

test('a browser click wakes the clicked machine with the server key', async () => {
  const { response, calls } = await mockDb(() => browser.POST(request('/api/login/browser', { accountId: account, deviceId: device })), call => {
    if (call.table === 'codex_accounts') return [{ id: account, email: 'fixture@example.com', account_key: 'chatgpt:fixture@example.com' }]
    if (call.table === 'codex_devices') return [{ id: device }]
    if (call.table === 'codex_browser_launches' && call.method === 'POST') return [{ id: launch }]
    return []
  })
  assert.equal(response.status, 200)
  const [wake] = wakes(calls)
  assert.ok(wake, 'the click broadcasts a wake')
  assert.equal(wake.headers.get('apikey'), 'fixture-service-role')
  assert.deepEqual(wake.body, { messages: [{ event: 'wake', payload: {}, topic: wakeTopicFor(device) }] })
})

test('a browser poll names the wake channel, and the helper counts as online for the idle poll window', async () => {
  const { response } = await mockDb(() => browser.POLL(request('/api/login/browser/poll', { deviceToken: 'fixture-device-token' })), call => {
    if (call.table === 'codex_devices' && call.method === 'GET') return [{ id: device, owner_user_id: owner }]
    return []
  })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).wake, {
    apikey: 'fixture-anon',
    topic: wakeTopicFor(device),
    url: 'wss://wake-fixture.invalid/realtime/v1/websocket',
  })

  const before = Date.now()
  const { calls } = await mockDb(() => browser.GET(request('/api/login/browser')))
  const since = Date.parse(calls.find(call => call.table === 'codex_devices').query.get('browser_agent_seen_at').replace(/^gte\./, ''))
  assert.ok(Math.abs(before - AGENT_ONLINE_WINDOW_MS - since) < 5_000, 'online means seen within the window, not the last 30 s')
  assert.ok(AGENT_ONLINE_WINDOW_MS >= 2 * 90_000, 'one missed idle poll never shows the helper offline')
})

test('a "Use" click wakes the machine it goes to, and its poll names the channel', async () => {
  const devices = [{ id: device, label: 'Mac', machine_name: 'mac', last_seen_at: new Date().toISOString(), metadata: { planSwitch: { active: { email: 'a@example.com', reportedAt: new Date().toISOString() } } } }]
  const { response, calls } = await mockDb(() => planSwitch.POST(request('/api/login/switch', { deviceId: device, email: 'b@example.com' })), call => call.table === 'codex_devices' && call.method === 'GET' ? devices : [])
  assert.equal(response.status, 200)
  assert.deepEqual(wakes(calls).map(call => call.body.messages[0].topic), [wakeTopicFor(device)])

  const polled = await mockDb(() => planSwitch.POLL(request('/api/login/switch/poll', { activeEmail: 'a@example.com', deviceToken: 'fixture-device-token' })), call => call.table === 'codex_devices' && call.method === 'GET' ? [{ id: device, metadata: {} }] : [])
  assert.equal((await polled.response.json()).wake.topic, wakeTopicFor(device))
})

test('a sign-in fix click wakes the machine, and its poll names the channel', async () => {
  const devices = [{ id: device, label: 'Mac', machine_name: 'mac', last_seen_at: new Date().toISOString(), metadata: { repair: { providers: ['codex'] } } }]
  const { response, calls } = await mockDb(() => repair.POST(request('/api/login/repair', { connect: 'new@example.com', deviceId: device })), call => call.table === 'codex_devices' && call.method === 'GET' ? devices : [])
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual(wakes(calls).map(call => call.body.messages[0].topic), [wakeTopicFor(device)])

  const polled = await mockDb(() => repair.POLL(request('/api/login/repair/poll', { deviceToken: 'fixture-device-token' })), call => call.table === 'codex_devices' && call.method === 'GET' ? [{ id: device, metadata: {} }] : [])
  assert.equal((await polled.response.json()).wake.topic, wakeTopicFor(device))
})

test('a refused click wakes nobody', async () => {
  const { response, calls } = await mockDb(() => browser.POST(request('/api/login/browser', { accountId: account, deviceId: device }, false)))
  assert.equal(response.status, 401)
  assert.equal(wakes(calls).length, 0)
})
