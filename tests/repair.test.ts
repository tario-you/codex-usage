import assert from 'node:assert/strict'
import test from 'node:test'

import { expiredEmailsFromResults } from '../bin/lib/sync-all.js'
import {
  REPAIR_PENDING_MAX_AGE_MS,
  needsSignIn,
  readRepairState,
  withExpiredReport,
  withPendingRequest,
  withResult,
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
