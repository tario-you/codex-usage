import assert from 'node:assert/strict'
import test from 'node:test'

import { accountsFromKnown, expiredEmailsFromResults, pendingFromPoll } from '../bin/lib/sync-all.js'
import {
  REPAIR_PENDING_MAX_AGE_MS,
  needsSignIn,
  readRepairState,
  REPAIR_LINK_MAX_AGE_MS,
  isSignInUrl,
  withConnectRequest,
  withExpiredReport,
  withPendingRequest,
  withResult,
  withSignInLink,
} from '../api/_lib/login/repair-state.ts'

test('only sign-in-expired failures become repair targets', () => {
  const emails = expiredEmailsFromResults([
    { email: 'A@x.com', ok: false, reason: 'sign-in expired; run login add' },
    { email: 'b@x.com', ok: false, reason: 'usage request failed (HTTP 500)' },
    { email: 'c@x.com', ok: true },
  ])
  assert.deepEqual(emails, ['a@x.com'])
})

test('a request only targets emails the agent reported as expired, and a fresh report clears the fixed ones', () => {
  const at = '2026-09-10T20:00:00.000Z'
  const reported = withExpiredReport({ other: 1 }, ['A@x.com', 'b@x.com', 'not-an-email'], at)
  assert.deepEqual(readRepairState(reported, Date.parse(at)).expired, ['a@x.com', 'b@x.com'])
  assert.equal((reported as { other?: number }).other, 1, 'other metadata survives')

  const none = withPendingRequest(reported, ['zzz@x.com'], at)
  assert.deepEqual(none.targets, [])
  const some = withPendingRequest(reported, ['b@x.com'], at)
  assert.deepEqual(some.targets, ['b@x.com'])
  assert.deepEqual(readRepairState(some.metadata, Date.parse(at)).pending, { emails: ['b@x.com'], requestedAt: at })
  const all = withPendingRequest(reported, undefined, at)
  assert.deepEqual(all.targets, ['a@x.com', 'b@x.com'])

  const stale = readRepairState(all.metadata, Date.parse(at) + REPAIR_PENDING_MAX_AGE_MS + 1)
  assert.equal(stale.pending, null, 'an old request expires instead of opening tabs forever')

  const done = withResult(all.metadata, [{ email: 'a@x.com', outcome: 'signed-in' }, { email: 'b@x.com', outcome: 'failed', detail: 'timed out' }], at)
  const state = readRepairState(done, Date.parse(at))
  assert.equal(state.pending, null)
  assert.deepEqual(state.expired, ['b@x.com'])
  assert.equal(state.lastResult?.results.length, 2)
})

test('accounts the machine used but never saved ride the report and qualify for the same request', () => {
  const at = '2026-09-10T21:00:00.000Z'
  const reported = withExpiredReport({}, ['old@x.com'], at, ['New@x.com', 'old@x.com', 'nope'])
  const state = readRepairState(reported, Date.parse(at))
  assert.deepEqual(state.expired, ['old@x.com'])
  assert.deepEqual(state.missing, ['new@x.com'], 'an expired login is never also missing')
  assert.deepEqual(needsSignIn(state), ['old@x.com', 'new@x.com'])

  const all = withPendingRequest(reported, undefined, at)
  assert.deepEqual(all.targets, ['old@x.com', 'new@x.com'])
  const one = withPendingRequest(reported, ['new@x.com'], at)
  assert.deepEqual(one.targets, ['new@x.com'])

  const done = withResult(all.metadata, [{ email: 'new@x.com', outcome: 'signed-in' }, { email: 'old@x.com', outcome: 'skipped' }], at)
  const after = readRepairState(done, Date.parse(at))
  assert.deepEqual(after.missing, [])
  assert.deepEqual(after.expired, ['old@x.com'])
  assert.equal(after.pending, null)

  const legacy = readRepairState({ repair: { expired: ['a@x.com'] } }, Date.parse(at))
  assert.deepEqual(legacy.missing, [], 'a report written before this field reads as none missing')
})

test('an email typed on the dashboard is signed in even though the machine never reported it', () => {
  const at = '2026-09-16T09:00:00.000Z'
  const reported = withExpiredReport({}, ['old@x.com'], at)
  assert.deepEqual(withPendingRequest(reported, ['brand-new@x.com'], at).targets, [], 'Fix sign-ins still refuses unknown emails')

  const none = withConnectRequest(reported, 'not-an-email', at)
  assert.deepEqual(none.targets, [])
  assert.equal(readRepairState(none.metadata, Date.parse(at)).pending, null)

  const one = withConnectRequest(reported, ' Brand-New@x.com ', at)
  assert.deepEqual(one.targets, ['brand-new@x.com'])
  assert.deepEqual(readRepairState(one.metadata, Date.parse(at)).pending, { emails: ['brand-new@x.com'], requestedAt: at })

  const joined = withConnectRequest(withPendingRequest(reported, undefined, at).metadata, 'brand-new@x.com', at)
  assert.deepEqual(joined.targets, ['old@x.com', 'brand-new@x.com'], 'joins a fresh request instead of dropping it')
  const again = withConnectRequest(joined.metadata, 'brand-new@x.com', at)
  assert.deepEqual(again.targets, ['old@x.com', 'brand-new@x.com'], 'no duplicate tab for a repeated click')

  const stale = withConnectRequest(withPendingRequest(reported, undefined, at).metadata, 'brand-new@x.com', new Date(Date.parse(at) + REPAIR_PENDING_MAX_AGE_MS + 1).toISOString())
  assert.deepEqual(stale.targets, ['brand-new@x.com'], 'an expired request does not ride along')

  const done = withResult(one.metadata, [{ email: 'brand-new@x.com', outcome: 'signed-in' }], at)
  const state = readRepairState(done, Date.parse(at))
  assert.equal(state.pending, null)
  assert.deepEqual(state.expired, ['old@x.com'])
})

test('the agent reads the pending request through parseResponseBody\'s { data, text } wrapper', () => {
  const pending = { emails: ['new@x.com'], requestedAt: '2026-09-16T17:37:57.427Z' }
  assert.deepEqual(pendingFromPoll({ data: { pending }, text: '{}' }), pending, 'the wrapped shape the CLI actually receives')
  assert.deepEqual(pendingFromPoll({ pending }), pending, 'a bare body still works')
  assert.equal(pendingFromPoll({ data: { pending: null }, text: '' }), null)
  assert.equal(pendingFromPoll({ data: {}, text: '' }), null)
  assert.equal(pendingFromPoll({ data: { pending: { emails: [], requestedAt: 'x' } }, text: '' }), null, 'no emails means nothing to open')
  assert.deepEqual(accountsFromKnown({ data: { accounts: ['a@x.com'] }, text: '' }), ['a@x.com'])
  assert.deepEqual(accountsFromKnown({ data: {}, text: '' }), [])
})

test('the sign-in link the agent opened rides the state until the sign-in ends or the link expires', () => {
  const at = '2026-09-17T07:00:00.000Z'
  const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=x&state=y'
  const pending = withConnectRequest({}, 'new@x.com', at).metadata
  assert.equal(readRepairState(pending, Date.parse(at)).link, null)

  assert.equal(isSignInUrl(url), true)
  assert.equal(isSignInUrl('http://auth.openai.com/x'), false, 'plain http is refused')
  assert.equal(isSignInUrl('https://evil.example/auth.openai.com'), false, 'a look-alike host is refused')
  assert.equal(withSignInLink(pending, 'new@x.com', 'javascript:alert(1)', at).link, null)
  assert.equal(withSignInLink(pending, 'nope', url, at).link, null)

  const linked = withSignInLink(pending, 'New@x.com', url, at)
  assert.deepEqual(linked.link, { at, email: 'new@x.com', url })
  const state = readRepairState(linked.metadata, Date.parse(at))
  assert.deepEqual(state.link, { at, email: 'new@x.com', url })
  assert.deepEqual(state.pending?.emails, ['new@x.com'], 'the request itself is untouched')

  const expired = readRepairState(linked.metadata, Date.parse(at) + REPAIR_LINK_MAX_AGE_MS + 1)
  assert.equal(expired.link, null, 'a ten-minute-old link is no longer offered')

  const done = withResult(linked.metadata, [{ email: 'new@x.com', outcome: 'signed-in' }], at)
  assert.equal(readRepairState(done, Date.parse(at)).link, null, 'the result clears the link')
  assert.equal(readRepairState({ repair: { expired: [] } }, Date.parse(at)).link, null, 'older rows read as no link')
})
