import assert from 'node:assert/strict'
import test from 'node:test'

import { authStorageKey } from '../src/lib/dashboard-client'
import { readPendingSession } from '../src/lib/pending-session'

const key = authStorageKey('https://example-ref.supabase.co')
const saved = {
  access_token: 'expired-token',
  refresh_token: 'refresh-token',
  expires_at: 1,
  token_type: 'bearer',
  user: { id: 'user-1', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' },
}
const storeWith = (value: string | null) => ({ getItem: (name: string) => (name === key ? value : null) })

test('an expired saved sign-in paints the dashboard as its user, with no token anything could send', () => {
  const pending = readPendingSession(storeWith(JSON.stringify(saved)), key, 'https://codexusage.vercel.app/')
  assert.equal(pending?.user.id, 'user-1', 'the cached rows are keyed by this user')
  assert.equal(pending?.access_token, '', 'token-gated reads wait for the refreshed session')
  assert.equal(pending?.refresh_token, '')
})

test('no saved sign-in, a damaged one or a sign-in redirect gives no pending session', () => {
  assert.equal(readPendingSession(storeWith(null), key, 'https://codexusage.vercel.app/'), null)
  assert.equal(readPendingSession(storeWith('{not json'), key, 'https://codexusage.vercel.app/'), null)
  assert.equal(readPendingSession(storeWith(JSON.stringify({ access_token: 'x' })), key, 'https://codexusage.vercel.app/'), null)
  assert.equal(readPendingSession(null, key, 'https://codexusage.vercel.app/'), null)
  for (const href of ['https://codexusage.vercel.app/?code=abc', 'https://codexusage.vercel.app/?token_hash=abc&type=magiclink', 'https://codexusage.vercel.app/#access_token=abc']) {
    assert.equal(readPendingSession(storeWith(JSON.stringify(saved)), key, href), null, href)
  }
})
