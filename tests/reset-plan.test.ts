import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildResetPlan,
  type ResetPlanAccount,
} from '../src/features/dashboard/reset-plan'

const NOW = Date.parse('2026-07-15T18:00:00.000Z')

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
