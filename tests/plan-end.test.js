import assert from 'node:assert/strict'
import test from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { formatPlanEnd, hasPlanEnded, planEndFromDateInput, planEndsAt, planEndToDateInput } from '../src/features/dashboard/plan-end'

const owner = '11111111-1111-4111-8111-111111111111'
const otherOwner = '22222222-2222-4222-8222-222222222222'
const mine = '33333333-3333-4333-8333-333333333333'
const theirs = '44444444-4444-4444-8444-444444444444'
const { privateKey, publicKey } = await generateKeyPair('ES256')
process.env.SUPABASE_URL = 'https://plan-end-fixture.invalid'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-role'
process.env.SUPABASE_JWKS = JSON.stringify({ keys: [{ ...await exportJWK(publicKey), kid: 'plan-end-test' }] })
const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'plan-end-test' })
  .setIssuer('https://plan-end-fixture.invalid/auth/v1').setAudience('authenticated').setSubject(owner).setExpirationTime('1h').sign(privateKey)
const route = await import('../api/_lib/login/plan-end.ts')
const { resolveLoginRoute } = await import('../api/login.ts')
const request = (body, authenticated = true) => new Request('https://dashboard.invalid/api/login/plan-end', {
  method: 'POST', headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

test('a calendar day becomes the start of that day and reads back as the same day', () => {
  const iso = planEndFromDateInput('2026-10-18')
  assert.ok(iso)
  const at = new Date(iso)
  assert.deepEqual([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()], [2026, 9, 18, 0, 0])
  assert.equal(planEndToDateInput(iso), '2026-10-18')
  assert.equal(planEndFromDateInput('2026-02-30'), null, 'no rollover into March')
  assert.equal(planEndFromDateInput('oct 18'), null, 'only a date input value, never free text')
  assert.equal(planEndToDateInput(null), '')
})

test('a plan has ended once its end arrives, and reads as ended', () => {
  const endsAt = planEndsAt({ plan_ends_at: '2026-10-18T07:00:00.000Z' })
  assert.equal(endsAt, Date.parse('2026-10-18T07:00:00.000Z'))
  assert.equal(hasPlanEnded({ plan_ends_at: '2026-10-18T07:00:00.000Z' }, endsAt - 1), false)
  assert.equal(hasPlanEnded({ plan_ends_at: '2026-10-18T07:00:00.000Z' }, endsAt), true)
  assert.equal(hasPlanEnded({ plan_ends_at: null }, endsAt), false)
  assert.equal(planEndsAt({ plan_ends_at: 'not a date' }), null)
  assert.match(formatPlanEnd(endsAt, endsAt - 1), /^ends /)
  assert.match(formatPlanEnd(endsAt, endsAt), /^ended /)
})

test('only the owner sets or clears a plan end, and only a real moment is stored', async () => {
  const originalFetch = globalThis.fetch
  const rows = [
    { id: mine, owner_user_id: owner, plan_ends_at: null },
    { id: theirs, owner_user_id: otherOwner, plan_ends_at: null },
  ]
  const calls = []
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    assert.equal(url.hostname, 'plan-end-fixture.invalid')
    assert.equal(url.pathname, '/rest/v1/codex_accounts')
    assert.equal(options.method, 'PATCH')
    calls.push(url.searchParams)
    const matches = (row) => [...url.searchParams].filter(([, value]) => value.startsWith('eq.'))
      .every(([field, value]) => row[field] === value.slice(3))
    const patch = JSON.parse(options.body)
    assert.deepEqual(Object.keys(patch), ['plan_ends_at'], 'a plan end write touches nothing else on the row')
    const updated = rows.filter(matches).map((row) => Object.assign(row, patch))
    const result = updated.map(({ id, plan_ends_at }) => ({ id, plan_ends_at }))
    const accept = new Headers(options.headers).get('accept') ?? ''
    return new Response(JSON.stringify(accept.includes('vnd.pgrst.object') ? result[0] ?? null : result), { headers: { 'content-type': 'application/json' } })
  }
  try {
    assert.equal(resolveLoginRoute('POST', '/api/login/plan-end'), route.POST)
    const saved = await route.POST(request({ accountId: mine, endsAt: '2026-10-18T00:00:00-07:00' }))
    assert.equal(saved.status, 200)
    assert.equal(rows[0].plan_ends_at, '2026-10-18T07:00:00.000Z')
    assert.equal((await route.POST(request({ accountId: theirs, endsAt: '2026-10-18T07:00:00Z' }))).status, 404)
    assert.equal(rows[1].plan_ends_at, null, 'another owner\'s plan is untouched')
    assert.equal((await route.POST(request({ accountId: mine, endsAt: null }))).status, 200)
    assert.equal(rows[0].plan_ends_at, null)
    const count = calls.length
    assert.equal((await route.POST(request({ accountId: mine, endsAt: 'ends oct 18' }))).status, 400)
    assert.equal((await route.POST(request({ accountId: mine, endsAt: '1999-01-01T00:00:00Z' }))).status, 400)
    assert.equal((await route.POST(request({ accountId: 'not-a-uuid', endsAt: null }))).status, 400)
    assert.equal((await route.POST(request({ accountId: mine, endsAt: null }, false))).status, 401)
    assert.equal(calls.length, count, 'invalid requests never reach storage')
  } finally {
    globalThis.fetch = originalFetch
  }
})
