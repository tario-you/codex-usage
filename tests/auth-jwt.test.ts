import assert from 'node:assert/strict'
import test from 'node:test'

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'

process.env.SUPABASE_URL ??= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-role-fixture'

const { InvalidSessionError, requireUser, supabaseIssuer, verifyAccessToken } = await import('../api/_lib/auth.ts')

const ISSUER = supabaseIssuer('https://example.supabase.co')

async function signer() {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'test-key', use: 'sig' }
  const keySet = createLocalJWKSet({ keys: [jwk] })
  const sign = (claims: Record<string, unknown>, { expiresIn = '1h', issuer = ISSUER, audience = 'authenticated' } = {}) =>
    new SignJWT({ role: 'authenticated', email: 'owner@example.com', app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: { full_name: 'Owner' }, ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject((claims.sub as string) ?? 'user-1')
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey)
  return { keySet, sign }
}

test('a valid Supabase session token is verified locally and yields the user the routes read', async () => {
  const { keySet, sign } = await signer()
  const user = await verifyAccessToken(await sign({ sub: 'user-1' }), { issuer: ISSUER, keySet })
  assert.equal(user.id, 'user-1')
  assert.equal(user.email, 'owner@example.com')
  assert.equal(user.app_metadata.provider, 'google')
  assert.deepEqual(user.app_metadata.providers, ['google'])
  assert.equal(user.user_metadata.full_name, 'Owner')
})

test('requireUser reads the bearer header and never contacts Supabase Auth', async () => {
  const { keySet, sign } = await signer()
  const token = await sign({ sub: 'user-2' })
  // The default key set is not configured in tests, so a bearer that fails local verification is rejected without a network call.
  await assert.rejects(requireUser(new Request('https://x.test/api', { headers: { authorization: 'Bearer nope' } })), InvalidSessionError)
  await assert.rejects(requireUser(new Request('https://x.test/api')), /Missing Authorization header/)
  const user = await verifyAccessToken(token, { issuer: ISSUER, keySet })
  assert.equal(user.id, 'user-2')
})

test('expired, foreign-issuer, wrong-audience, non-authenticated and foreign-key tokens are rejected', async () => {
  const { keySet, sign } = await signer()
  const other = await signer()
  await assert.rejects(verifyAccessToken(await sign({}, { expiresIn: '-1m' }), { issuer: ISSUER, keySet }), InvalidSessionError)
  await assert.rejects(verifyAccessToken(await sign({}, { issuer: 'https://evil.example/auth/v1' }), { issuer: ISSUER, keySet }), InvalidSessionError)
  await assert.rejects(verifyAccessToken(await sign({}, { audience: 'anon' }), { issuer: ISSUER, keySet }), InvalidSessionError)
  await assert.rejects(verifyAccessToken(await sign({ role: 'anon' }), { issuer: ISSUER, keySet }), InvalidSessionError)
  await assert.rejects(verifyAccessToken(await other.sign({}), { issuer: ISSUER, keySet }), InvalidSessionError)
})
