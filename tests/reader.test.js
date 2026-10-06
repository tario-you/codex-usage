import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

const owner = '11111111-1111-4111-8111-111111111111'
const readerId = '66666666-6666-4666-8666-666666666666'
const page = 'https://her-tario.moonshot.computer/mac/0123456789abcdef0123456789abcdef/codexusage/back'
const { privateKey, publicKey } = await generateKeyPair('ES256')
process.env.SUPABASE_URL = 'https://reader-fixture.invalid'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-role'
process.env.SUPABASE_JWKS = JSON.stringify({ keys: [{ ...await exportJWK(publicKey), kid: 'reader-test' }] })
const session = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'reader-test' })
  .setIssuer('https://reader-fixture.invalid/auth/v1').setAudience('authenticated').setSubject(owner).setExpirationTime('1h').sign(privateKey)
const reader = await import('../api/_lib/login/reader.ts')
const { resolveLoginRoute } = await import('../api/login.ts')
const { takePendingReaderGrant } = await import('../src/features/dashboard/reader-grant.ts')
const originalFetch = globalThis.fetch
const sha = value => createHash('sha256').update(value).digest('hex')

const request = (path, { body, bearer } = {}) => new Request(`https://dashboard.invalid${path}`, {
  method: body ? 'POST' : 'GET',
  headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
})

async function mockDb(run, respond = () => []) {
  const calls = []
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(options.headers)
    const call = { path: url.pathname, table: url.pathname.split('/').at(-1), query: url.searchParams, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null }
    calls.push(call)
    const rows = respond(call)
    return new Response(JSON.stringify((headers.get('accept') ?? '').includes('vnd.pgrst.object') ? rows[0] ?? null : rows), { headers: { 'content-type': 'application/json' } })
  }
  try { return { response: await run(), calls } } finally { globalThis.fetch = originalFetch }
}

test('a code goes back only to a Samantha Mac page on her own hosts', () => {
  assert.ok(reader.readerReturnUrl(page))
  assert.ok(reader.readerReturnUrl(page.replace('her-tario.', 'her.')))
  for (const bad of [page.replace('https:', 'http:'), page.replace('moonshot.computer', 'evil.example'), `${page}?x=1`, `${page}#x`,
    page.replace('/back', '/elsewhere'), 'https://her-tario.moonshot.computer:8443/mac/0123456789abcdef0123456789abcdef/codexusage/back', 'javascript:alert(1)', 42]) {
    assert.equal(reader.readerReturnUrl(bad), null, String(bad))
  }
})

test('the dispatcher serves the reader routes', () => {
  for (const [method, path] of [['POST', '/api/login/reader/start'], ['POST', '/api/login/reader/claim'], ['GET', '/api/login/reader/feed'], ['POST', '/api/login/reader/revoke']]) {
    assert.ok(resolveLoginRoute(method, path), `${method} ${path}`)
  }
})

test('Allow needs his session and sends him back with a one-time code and his state', async () => {
  const unsigned = await reader.START(request('/api/login/reader/start', { body: { returnTo: page, state: 'state-fixture-123456' } }))
  assert.equal(unsigned.status, 401)
  const elsewhere = await reader.START(request('/api/login/reader/start', { body: { returnTo: 'https://evil.example/mac/x', state: 'state-fixture-123456' }, bearer: session }))
  assert.equal(elsewhere.status, 400)
  const { response, calls } = await mockDb(() => reader.START(request('/api/login/reader/start', { body: { returnTo: page, state: 'state-fixture-123456' }, bearer: session })))
  assert.equal(response.status, 200)
  const back = new URL((await response.json()).url)
  assert.equal(back.origin + back.pathname, page)
  assert.equal(back.searchParams.get('state'), 'state-fixture-123456')
  const insert = calls.find(call => call.table === 'codex_readers' && call.method === 'POST').body
  assert.equal(insert.owner_user_id, owner)
  assert.equal(insert.code_hash, sha(back.searchParams.get('code')), 'only the code hash is kept')
  assert.equal(insert.return_origin, 'https://her-tario.moonshot.computer')
  assert.ok(Date.parse(insert.code_expires_at) - Date.now() <= reader.READER_CODE_TTL_MS)
})

test('a code is claimed once for a token, and older readers for that page end', async () => {
  const code = 'c'.repeat(43)
  const { response, calls } = await mockDb(() => reader.CLAIM(request('/api/login/reader/claim', { body: { code } })), call =>
    call.table === 'codex_readers' && call.method === 'PATCH' && call.query.get('code_hash') ? [{ id: readerId, owner_user_id: owner, return_origin: 'https://her-tario.moonshot.computer' }] : [])
  assert.equal(response.status, 200)
  const { token } = await response.json()
  const [claim, revoke] = calls.filter(call => call.table === 'codex_readers' && call.method === 'PATCH')
  assert.equal(claim.query.get('code_hash'), `eq.${sha(code)}`)
  assert.equal(claim.query.get('token_hash'), 'is.null')
  assert.equal(claim.body.token_hash, sha(token))
  assert.equal(claim.body.code_hash, null)
  assert.equal(revoke.query.get('id'), `neq.${readerId}`)
  assert.ok(revoke.body.revoked_at)

  const { response: used } = await mockDb(() => reader.CLAIM(request('/api/login/reader/claim', { body: { code } })))
  assert.equal(used.status, 410)
})

test('the feed reads as the owner through the reader functions and never returns machine paths', async () => {
  const token = 't'.repeat(43)
  const { response, calls } = await mockDb(() => reader.FEED(request('/api/login/reader/feed?range=30d', { bearer: token })), call => {
    if (call.table === 'codex_readers' && call.method === 'GET') return [{ id: readerId, owner_user_id: owner }]
    if (call.table === 'reader_dashboard_accounts') return [{ id: 'a1', account_key: 'claude:a@example.com', email: 'a@example.com', codex_home: '/Users/x/.codex', source_key: 'device_x', primary_used_percent: 27, primary_window_mins: 10080, secondary_used_percent: null }]
    if (call.table === 'reader_weighted_weekly_usage_history') return [{ fetched_at: '2026-10-05T00:00:00Z', total_remaining_percent: '73', account_count: 1, total_capacity_percent: '100' }]
    return []
  })
  assert.equal(response.status, 200)
  const feed = await response.json()
  assert.equal(feed.range, '30d')
  assert.equal(feed.accounts[0].primary_remaining_percent, 73)
  assert.ok(!('codex_home' in feed.accounts[0]) && !('source_key' in feed.accounts[0]))
  assert.deepEqual(feed.history.map(p => [p.provider, p.totalRemainingPercent]), [['codex', 73], ['claude', 73]])
  const rpcs = calls.filter(call => call.path.startsWith('/rest/v1/rpc/'))
  assert.ok(rpcs.every(call => call.body.reader_owner === owner))
  assert.equal(calls.find(call => call.table === 'codex_readers').query.get('token_hash'), `eq.${sha(token)}`)

  const { response: none } = await mockDb(() => reader.FEED(request('/api/login/reader/feed', { bearer: token })))
  assert.equal(none.status, 401)
})

test('the dashboard keeps Samantha’s request through a sign-in and takes it out of the address bar', () => {
  const kept = new Map()
  const store = { getItem: k => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v), removeItem: k => kept.delete(k) }
  let replaced = null
  const pending = takePendingReaderGrant(`https://codexusage.vercel.app/?samantha_return=${encodeURIComponent(page)}&samantha_state=s1234567890123456`, store, url => { replaced = url })
  assert.deepEqual(pending, { returnTo: page, state: 's1234567890123456' })
  assert.equal(replaced, 'https://codexusage.vercel.app/')
  assert.deepEqual(takePendingReaderGrant('https://codexusage.vercel.app/', store, () => {}), pending)
})
