import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { encryptSharedLogin } from '../api/_lib/login-crypto'

const owner = '11111111-1111-4111-8111-111111111111'
const otherOwner = '22222222-2222-4222-8222-222222222222'
const email = 'same@example.com'
const { privateKey, publicKey } = await generateKeyPair('ES256')
process.env.SUPABASE_URL = 'https://notes-fixture.invalid'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-role'
process.env.SUPABASE_JWKS = JSON.stringify({ keys: [{ ...await exportJWK(publicKey), kid: 'notes-test' }] })
process.env.CODEX_LOGIN_ENCRYPTION_KEY = randomBytes(32).toString('base64')
const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'notes-test' })
  .setIssuer('https://notes-fixture.invalid/auth/v1').setAudience('authenticated').setSubject(owner).setExpirationTime('1h').sign(privateKey)
const routes = await import('../api/_lib/login/notes.ts')
const request = (body, authenticated = true) => new Request('https://dashboard.invalid/api/login/notes', {
  method: body ? 'POST' : 'GET', headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
})

test('saving, clearing and deleting one provider leave the other provider and owner untouched', async () => {
  const originalFetch = globalThis.fetch
  const legacy = encryptSharedLogin(JSON.stringify({ v: 1, note: 'legacy note' }), `account-note:${owner}:${email}`)
  let rows = [
    ...['codex', 'claude'].map(provider => ({ owner_user_id: owner, email, provider, aad_version: 1, ciphertext: legacy.ciphertext, key_version: legacy.keyVersion })),
    { owner_user_id: otherOwner, email, provider: 'claude', ciphertext: 'other-owner-untouched' },
  ]
  const calls = []
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    assert.equal(url.hostname, 'notes-fixture.invalid')
    assert.equal(url.pathname, '/rest/v1/codex_account_notes')
    const method = options.method ?? 'GET'
    calls.push({ method, query: url.searchParams })
    const matches = row => [...url.searchParams].filter(([, value]) => value.startsWith('eq.'))
      .every(([field, value]) => row[field] === value.slice(3))
    let result
    if (method === 'POST') {
      const row = JSON.parse(options.body)
      const conflict = url.searchParams.get('on_conflict').split(',')
      assert.deepEqual(conflict, ['owner_user_id', 'provider', 'email'])
      assert.equal(row.aad_version, 2)
      rows = rows.filter(existing => !conflict.every(field => existing[field] === row[field]))
      rows.push(row)
      result = [row]
    } else if (method === 'DELETE') {
      rows = rows.filter(row => !matches(row))
      result = []
    } else {
      result = rows.filter(matches)
      const selected = url.searchParams.get('select').split(',')
      result = result.map(row => Object.fromEntries(selected.map(field => [field, row[field]])))
    }
    const accept = new Headers(options.headers).get('accept') ?? ''
    return new Response(JSON.stringify(accept.includes('vnd.pgrst.object') ? result[0] : result), { headers: { 'content-type': 'application/json' } })
  }
  const read = async () => {
    const response = await routes.GET(request())
    assert.equal(response.status, 200)
    return (await response.json()).notes
  }
  try {
    const before = await read()
    assert.deepEqual(before.map(note => note.note), ['legacy note', 'legacy note'])
    const save = await routes.POST(request({ provider: 'claude', email: ' SAME@Example.com ', note: 'Claude only', chatgptPassword: 'claude-password' }))
    assert.equal(save.status, 200)
    assert.equal((await save.json()).note.provider, 'claude')
    let notes = await read()
    assert.equal(notes.find(note => note.provider === 'codex').note, 'legacy note')
    assert.equal(notes.find(note => note.provider === 'claude').note, 'Claude only')
    assert.equal(notes.find(note => note.provider === 'claude').chatgptPassword, 'claude-password')
    assert.equal((await routes.POST(request({ provider: 'codex', email, note: 'Codex only' }))).status, 200)
    assert.equal((await routes.POST(request({ provider: 'claude', email, note: '  ' }))).status, 200)
    notes = await read()
    assert.deepEqual(notes.map(note => [note.provider, note.note]), [['codex', 'Codex only']])
    assert.equal((await routes.POST(request({ provider: 'claude', email, note: 'restored' }))).status, 200)
    assert.equal((await routes.DELETE(request({ provider: 'codex', email }))).status, 200)
    assert.deepEqual((await read()).map(note => [note.provider, note.note]), [['claude', 'restored']])
    assert.equal(rows.find(row => row.owner_user_id === otherOwner).ciphertext, 'other-owner-untouched')
    const count = calls.length
    assert.equal((await routes.POST(request({ email, note: 'ambiguous old tab' }))).status, 400)
    assert.equal((await routes.DELETE(request({ email }))).status, 400)
    assert.equal((await routes.GET(request(undefined, false))).status, 401)
    assert.equal(calls.length, count, 'invalid requests never reach storage')
  } finally {
    globalThis.fetch = originalFetch
  }
})
