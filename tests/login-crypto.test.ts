import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import {
  describeSharedLogin,
  fingerprintSharedLogin,
  parseSharedLoginFile,
} from '../api/_lib/login-file'
import {
  LoginSharingUnavailableError,
  decryptSharedLogin,
  encryptSharedLogin,
  loadLoginEncryptionKey,
} from '../api/_lib/login-crypto'
import { reconcileSharedLogin } from '../api/_lib/login-reconcile'

const KEY = randomBytes(32)

test('encrypts and decrypts a login bound to its account id', () => {
  const plaintext = JSON.stringify({ tokens: { access_token: 'secret' } })
  const encrypted = encryptSharedLogin(plaintext, 'account-1', KEY)

  assert.notEqual(encrypted.ciphertext, plaintext)
  assert.equal(
    decryptSharedLogin(encrypted.ciphertext, 'account-1', encrypted.keyVersion, KEY),
    plaintext,
  )
  assert.throws(() =>
    decryptSharedLogin(encrypted.ciphertext, 'account-2', encrypted.keyVersion, KEY),
  )
  assert.throws(() =>
    decryptSharedLogin(encrypted.ciphertext, 'account-1', encrypted.keyVersion, randomBytes(32)),
  )
})

test('refuses a missing or short encryption key', () => {
  assert.throws(() => loadLoginEncryptionKey(''), LoginSharingUnavailableError)
  assert.throws(
    () => loadLoginEncryptionKey(randomBytes(16).toString('base64')),
    LoginSharingUnavailableError,
  )
  assert.equal(loadLoginEncryptionKey(KEY.toString('base64')).length, 32)
})

test('describes a ChatGPT login from its access token claims', () => {
  const file = parseSharedLoginFile(buildAuthFile({ issuedAt: 1_700_000_000 }))
  const identity = describeSharedLogin(file)

  assert.equal(identity.email, 'owner@example.com')
  assert.equal(identity.planType, 'pro')
  assert.equal(identity.accountId, 'acct-123')
  assert.equal(identity.issuedAt, new Date(1_700_000_000 * 1000).toISOString())
  assert.equal(fingerprintSharedLogin(file).length, 64)
})

test('refuses API key logins', () => {
  assert.throws(
    () => parseSharedLoginFile({ ...buildAuthFile({}), OPENAI_API_KEY: 'sk-test' }),
    /API key/,
  )
  assert.throws(
    () => parseSharedLoginFile({ ...buildAuthFile({}), auth_mode: 'apikey' }),
    /auth mode/,
  )
})

test('the newest token generation wins on reconcile', async () => {
  const older = parseSharedLoginFile(buildAuthFile({ issuedAt: 1_700_000_000, salt: 'a' }))
  const newer = parseSharedLoginFile(buildAuthFile({ issuedAt: 1_700_000_500, salt: 'b' }))
  const stored: string[] = []
  const secret = {
    account_id: 'account-1',
    fingerprint: fingerprintSharedLogin(older),
    token_issued_at: describeSharedLogin(older).issuedAt,
  }
  const store = async (file: typeof older) => {
    stored.push(fingerprintSharedLogin(file))
    return {
      ...secret,
      fingerprint: fingerprintSharedLogin(file),
      token_issued_at: describeSharedLogin(file).issuedAt,
    }
  }

  const open = () => older
  const pushed = await reconcileSharedLogin({
    clientFile: newer,
    clientFingerprint: null,
    open,
    secret,
    store,
  })
  assert.equal(pushed.outcome, 'stored')
  assert.deepEqual(stored, [fingerprintSharedLogin(newer)])

  const unchanged = await reconcileSharedLogin({
    clientFile: older,
    clientFingerprint: null,
    open,
    secret,
    store,
  })
  assert.equal(unchanged.outcome, 'unchanged')
  assert.equal(stored.length, 1)

  const pulled = await reconcileSharedLogin({
    clientFile: null,
    clientFingerprint: 'something-else',
    open,
    secret,
    store,
  })
  assert.equal(pulled.outcome, 'pull')
  assert.equal(pulled.file, older)

  const same = await reconcileSharedLogin({
    clientFile: null,
    clientFingerprint: secret.fingerprint,
    open,
    secret,
    store,
  })
  assert.equal(same.outcome, 'unchanged')

  await assert.rejects(
    reconcileSharedLogin({ clientFile: null, clientFingerprint: 'x', open, secret: null, store }),
    /no longer shared/,
  )
})

function buildAuthFile({ issuedAt = 1_700_000_000, salt = '' }: { issuedAt?: number; salt?: string }) {
  const accessToken = encodeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123', chatgpt_plan_type: 'pro' },
    'https://api.openai.com/profile': { email: 'Owner@example.com' },
    exp: issuedAt + 864_000,
    iat: issuedAt,
    salt,
  })
  const idToken = encodeJwt({ email: 'Owner@example.com', iat: issuedAt })

  return {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    last_refresh: new Date(issuedAt * 1000).toISOString(),
    tokens: {
      access_token: accessToken,
      account_id: 'acct-123',
      id_token: idToken,
      refresh_token: `refresh-${salt}`,
    },
  }
}

function encodeJwt(payload: Record<string, unknown>) {
  const segment = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${segment({ alg: 'none' })}.${segment(payload)}.sig`
}
