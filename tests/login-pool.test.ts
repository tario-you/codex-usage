import assert from 'node:assert/strict'
import test from 'node:test'

import { chooseNextAccount, type PoolAccount } from '../api/_lib/login-pool-choice'

const NOW = Date.parse('2026-09-08T22:00:00.000Z')

test('a recipient stays on its account while it has usable balance', () => {
  const decision = chooseNextAccount({
    accounts: [
      account({ id: 'a', primary_remaining_percent: 5, secondary_remaining_percent: 40 }),
      account({ id: 'b', primary_remaining_percent: 100, secondary_remaining_percent: 100 }),
    ],
    currentAccountId: 'a',
    now: NOW,
  })

  assert.equal(decision.reason, 'stay')
  assert.equal(decision.accountId, 'a')
  assert.equal(decision.usablePercent, 5)
})

test('missing usage data never causes a switch', () => {
  const decision = chooseNextAccount({
    accounts: [
      account({
        id: 'a',
        primary_remaining_percent: null,
        primary_resets_at: null,
        primary_used_percent: null,
        primary_window_mins: null,
        secondary_remaining_percent: null,
        secondary_resets_at: null,
        secondary_used_percent: null,
        secondary_window_mins: null,
      }),
      account({ id: 'b' }),
    ],
    currentAccountId: 'a',
    now: NOW,
  })

  assert.equal(decision.reason, 'stay')
  assert.equal(decision.accountId, 'a')
})

test('an exhausted account moves the recipient to the reset plan pick', () => {
  const decision = chooseNextAccount({
    accounts: [
      account({ id: 'a', primary_remaining_percent: 0, primary_used_percent: 100 }),
      account({
        id: 'later',
        primary_remaining_percent: 90,
        primary_resets_at: isoAfterHours(4),
      }),
      account({
        id: 'soon',
        primary_remaining_percent: 30,
        primary_resets_at: isoAfterHours(1),
      }),
    ],
    currentAccountId: 'a',
    now: NOW,
  })

  assert.equal(decision.reason, 'switch')
  assert.equal(decision.accountId, 'soon', 'nearest reset wins, like the dashboard plan')
})

test('a fresh claim starts on the recommended account', () => {
  const decision = chooseNextAccount({
    accounts: [
      account({ id: 'empty', primary_remaining_percent: 0, primary_used_percent: 100 }),
      account({ id: 'full', primary_remaining_percent: 100, secondary_remaining_percent: 100 }),
    ],
    currentAccountId: null,
    now: NOW,
  })

  assert.equal(decision.reason, 'initial')
  assert.equal(decision.accountId, 'full')
})

test('when every account is exhausted the recipient stays and learns the next reset', () => {
  const decision = chooseNextAccount({
    accounts: [
      account({
        id: 'a',
        primary_remaining_percent: 0,
        primary_resets_at: isoAfterHours(2),
        primary_used_percent: 100,
        secondary_remaining_percent: 50,
      }),
      account({
        id: 'b',
        primary_remaining_percent: 0,
        primary_resets_at: isoAfterHours(6),
        primary_used_percent: 100,
        secondary_remaining_percent: 0,
        secondary_resets_at: isoAfterHours(30),
        secondary_used_percent: 100,
      }),
    ],
    currentAccountId: 'b',
    now: NOW,
  })

  assert.equal(decision.reason, 'exhausted')
  assert.equal(decision.accountId, 'b')
  assert.equal(decision.nextAvailableAt, new Date(NOW + 2 * 60 * 60 * 1000).toISOString())
})

test('a fresh claim with nothing usable still hands out an account', () => {
  const decision = chooseNextAccount({
    accounts: [
      account({ id: 'a', primary_remaining_percent: 0, primary_used_percent: 100, primary_resets_at: isoAfterHours(3) }),
    ],
    currentAccountId: null,
    now: NOW,
  })

  assert.equal(decision.reason, 'exhausted')
  assert.equal(decision.accountId, 'a')
})

function account(overrides: Partial<PoolAccount> & { id: string }): PoolAccount {
  const primaryRemaining = overrides.primary_remaining_percent ?? 100
  const secondaryRemaining = overrides.secondary_remaining_percent ?? 100

  return {
    account_key: `chatgpt:${overrides.id}@example.com`,
    email: `${overrides.id}@example.com`,
    label: overrides.id,
    plan_type: 'pro',
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
