import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildResetPlan,
  orderAccountsForUse,
  type ResetPlanAccount,
} from '../src/features/dashboard/reset-plan'

const NOW = Date.parse('2026-07-15T18:00:00.000Z')

test('table order follows the recommendation and keeps exhausted and unknown rows at the bottom', () => {
  const rows = [
    account({ id: 'empty', primary_remaining_percent: 0 }),
    account({ id: 'later', primary_remaining_percent: 90, primary_resets_at: isoAfterHours(4) }),
    account({ id: 'soon-low', primary_remaining_percent: 30, primary_resets_at: isoAfterHours(1) }),
    account({ id: 'unknown', primary_used_percent: null, primary_remaining_percent: null, secondary_used_percent: null, secondary_remaining_percent: null }),
    account({ id: 'soon-high', primary_remaining_percent: 80, primary_resets_at: isoAfterHours(1) }),
    account({ id: 'weekly-empty', secondary_remaining_percent: 0, primary_resets_at: isoAfterHours(0.5) }),
  ]
  const original = [...rows]
  const ordered = orderAccountsForUse(rows, NOW)
  assert.deepEqual(ordered.map((row) => row.id), ['soon-high', 'soon-low', 'later', 'empty', 'unknown', 'weekly-empty'])
  assert.equal(ordered[0].id, buildResetPlan(rows, NOW).current?.accountId)
  assert.deepEqual(rows, original, 'the query cache is not reordered in place')
  assert.ok(ordered.every((row) => rows.includes(row)), 'keep original account identities and controls')
})

test('unknown reset times use balance then label, instead of a NaN comparison', () => {
  const rows = [
    account({ id: 'low', label: 'Low', primary_remaining_percent: 20, primary_resets_at: null, secondary_resets_at: null }),
    account({ id: 'z', label: 'Z', primary_remaining_percent: 80, primary_resets_at: 'invalid', secondary_resets_at: null }),
    account({ id: 'a', label: 'A', primary_remaining_percent: 80, primary_resets_at: new Date(NOW - 1).toISOString(), secondary_resets_at: null }),
  ]
  assert.deepEqual(orderAccountsForUse(rows, NOW).map((row) => row.id), ['a', 'z', 'low'])
})

test('a spent weekly allowance sinks below every row with weekly left, whatever its 5-hour says', () => {
  const claude = (id: string, overrides: Partial<ResetPlanAccount>) =>
    account({ id, label: `${id}@example.test`, account_key: `claude:${id}@example.test`, ...overrides })
  const rows = [
    claude('fresh', { primary_remaining_percent: 95, primary_resets_at: isoAfterHours(4.5), secondary_remaining_percent: 32, secondary_resets_at: isoAfterHours(105) }),
    claude('weekly-out-late', { primary_remaining_percent: 88, primary_resets_at: isoAfterHours(2.5), secondary_remaining_percent: 0, secondary_resets_at: isoAfterHours(121) }),
    claude('weekly-out-soon', { primary_remaining_percent: 0, primary_resets_at: isoAfterHours(-1), secondary_remaining_percent: 0, secondary_resets_at: isoAfterHours(73) }),
    claude('five-hour-out', { primary_remaining_percent: 0, primary_resets_at: isoAfterHours(1), secondary_remaining_percent: 20, secondary_resets_at: isoAfterHours(64) }),
    claude('refilled', { primary_remaining_percent: 51, primary_resets_at: isoAfterHours(-2), secondary_remaining_percent: 0, secondary_resets_at: isoAfterHours(-0.5) }),
  ]
  assert.deepEqual(orderAccountsForUse(rows, NOW).map((row) => row.id), ['fresh', 'refilled', 'five-hour-out', 'weekly-out-soon', 'weekly-out-late'])
})

test('a spent weekly Codex row sits below a usable Claude row', () => {
  const codex = account({ id: 'codex', secondary_remaining_percent: 0 })
  const claude = account({ id: 'claude', account_key: 'claude:fixture@example.com' })
  assert.deepEqual(orderAccountsForUse([codex, claude], NOW).map((row) => row.id), ['claude', 'codex'])
})

test('a window whose reset has passed counts as full again', () => {
  const plan = buildResetPlan(
    [account({ primary_remaining_percent: 0, primary_resets_at: isoAfterHours(-0.1), secondary_remaining_percent: 40 })],
    NOW,
  )
  assert.equal(plan.current?.usablePercent, 40)
  assert.equal(plan.current?.limitingWindowLabel, 'Weekly')
  assert.ok(plan.upcomingResets.every((event) => event.windowKey !== 'primary'), 'a passed reset is not upcoming')
})

test('order updates after a reset passes and after a new usage snapshot exhausts a plan', () => {
  const rows = [
    account({ id: 'soon', primary_resets_at: isoAfterHours(1) }),
    account({ id: 'later', primary_resets_at: isoAfterHours(2) }),
  ]
  assert.equal(orderAccountsForUse(rows, NOW)[0].id, 'soon')
  assert.equal(orderAccountsForUse(rows, NOW + 90 * 60_000)[0].id, 'later')
  rows[0] = account({ id: 'soon', primary_remaining_percent: 0 })
  assert.equal(orderAccountsForUse(rows, NOW)[0].id, 'later')
})

test('Claude rows are preserved without becoming Codex recommendations', () => {
  const claude = account({ id: 'claude', account_key: 'claude:fixture@example.com', primary_resets_at: isoAfterHours(0.1) })
  const codex = account({ id: 'codex' })
  assert.deepEqual(orderAccountsForUse([claude, codex], NOW), [codex, claude])
  assert.deepEqual(orderAccountsForUse([claude], NOW), [claude])
  assert.deepEqual(orderAccountsForUse([], NOW), [])
})

test('uses the account whose available allowance expires first', () => {
  const plan = buildResetPlan(
    [
      account({
        id: 'later',
        label: 'Later reset',
        primary_remaining_percent: 90,
        primary_resets_at: isoAfterHours(4),
      }),
      account({
        id: 'soon',
        label: 'Soon reset',
        primary_remaining_percent: 30,
        primary_resets_at: isoAfterHours(1),
      }),
    ],
    NOW,
  )

  assert.equal(plan.current?.accountId, 'soon')
  assert.deepEqual(
    plan.fallbacks.map((fallback) => fallback.accountId),
    ['later'],
  )
})

test('uses the lowest rate-limit window as the usable balance', () => {
  const plan = buildResetPlan(
    [
      account({
        primary_remaining_percent: 80,
        secondary_remaining_percent: 25,
      }),
    ],
    NOW,
  )

  assert.equal(plan.current?.usablePercent, 25)
  assert.equal(plan.current?.limitingWindowLabel, 'Weekly')
})

test('waits for the first reset that actually restores usable balance', () => {
  const plan = buildResetPlan(
    [
      account({
        primary_remaining_percent: 0,
        primary_resets_at: isoAfterHours(1),
        secondary_remaining_percent: 0,
        secondary_resets_at: isoAfterHours(12),
      }),
    ],
    NOW,
  )

  assert.equal(plan.current, null)
  assert.equal(plan.nextAvailable?.windowKey, 'secondary')
  assert.equal(plan.nextAvailable?.at, NOW + 12 * 60 * 60 * 1000)
  assert.equal(plan.nextAvailable?.projectedUsablePercent, 100)
})

test('ignores expired or invalid reset timestamps', () => {
  const plan = buildResetPlan(
    [
      account({
        primary_remaining_percent: 50,
        primary_resets_at: 'not-a-date',
        secondary_resets_at: new Date(NOW - 1).toISOString(),
      }),
    ],
    NOW,
  )

  assert.equal(plan.current?.nextResetAt, null)
  assert.deepEqual(plan.upcomingResets, [])
})

test('treats a weekly primary with no secondary as one weekly-only limit', () => {
  const plan = buildResetPlan(
    [
      account({
        primary_remaining_percent: 72,
        primary_resets_at: isoAfterHours(48),
        primary_used_percent: 28,
        primary_window_mins: 10_080,
        secondary_remaining_percent: 100,
        secondary_resets_at: null,
        secondary_used_percent: null,
        secondary_window_mins: null,
      }),
    ],
    NOW,
  )

  assert.equal(plan.current?.usablePercent, 72)
  assert.equal(plan.current?.limitingWindowLabel, 'Weekly')
  assert.equal(plan.upcomingResets.length, 1)
  assert.equal(plan.upcomingResets[0]?.windowLabel, 'Weekly')
})

test('a Claude login is never the next Codex plan, even with the most left', () => {
  const plan = buildResetPlan(
    [
      account({ id: 'codex', label: 'Codex', primary_remaining_percent: 10, primary_resets_at: isoAfterHours(1) }),
      account({ account_key: 'claude:me@example.com', id: 'claude', label: 'Claude', primary_remaining_percent: 95, primary_resets_at: isoAfterHours(2) }),
    ],
    NOW,
  )

  assert.equal(plan.current?.accountId, 'codex')
  assert.deepEqual(plan.fallbacks, [])
  assert.ok(plan.upcomingResets.every((event) => event.accountId !== 'claude'), 'the reset schedule is Codex-only too')
})

function account(overrides: Partial<ResetPlanAccount>): ResetPlanAccount {
  const primaryRemaining = overrides.primary_remaining_percent ?? 100
  const secondaryRemaining = overrides.secondary_remaining_percent ?? 100

  return {
    account_key: 'chatgpt:test@example.com',
    email: 'test@example.com',
    id: 'test',
    label: 'Test account',
    primary_remaining_percent: primaryRemaining,
    primary_resets_at: isoAfterHours(5),
    primary_used_percent: 100 - primaryRemaining,
    primary_window_mins: 300,
    secondary_remaining_percent: secondaryRemaining,
    secondary_resets_at: isoAfterHours(24),
    secondary_used_percent: 100 - secondaryRemaining,
    secondary_window_mins: 10_080,
    ...overrides,
  }
}

function isoAfterHours(hours: number) {
  return new Date(NOW + hours * 60 * 60 * 1000).toISOString()
}
