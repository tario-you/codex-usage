import {
  buildResetPlan,
  type ResetPlanAccount,
} from '../../src/features/dashboard/reset-plan.js'
import { getRateLimitWindows } from '../../src/shared/rate-limit-windows.js'

// Pure pool logic with no database or environment imports, so it can be unit
// tested and reasoned about on its own. Database access lives in login-pool.ts.

export interface PoolAccount extends ResetPlanAccount {
  plan_type: string | null
}

export interface PoolDecision {
  accountId: string | null
  nextAvailableAt: string | null
  reason: 'exhausted' | 'initial' | 'stay' | 'switch'
  usablePercent: number | null
}

/**
 * Which published account a pool recipient should be on right now.
 *
 * A recipient stays on its current account while that account still has a
 * known positive usable balance (or no usage data at all, so missing data
 * never causes churn). Once it hits zero, the recipient moves to the account
 * the reset plan recommends, which is the same ordering the dashboard shows:
 * nearest upcoming reset first, then the higher balance. When every account
 * is exhausted the recipient stays put and learns when the next reset lands.
 */
export function chooseNextAccount({
  accounts,
  currentAccountId,
  now = Date.now(),
}: {
  accounts: PoolAccount[]
  currentAccountId: string | null
  now?: number
}): PoolDecision {
  const current = accounts.find((account) => account.id === currentAccountId) ?? null
  const currentUsable = current ? usablePercent(current) : null

  if (current && (currentUsable == null || currentUsable > 0)) {
    return {
      accountId: current.id,
      nextAvailableAt: null,
      reason: 'stay',
      usablePercent: currentUsable,
    }
  }

  const plan = buildResetPlan(accounts, now)
  const target = plan.current?.accountId ?? null

  if (target && target !== current?.id) {
    return {
      accountId: target,
      nextAvailableAt: null,
      reason: current ? 'switch' : 'initial',
      usablePercent: plan.current?.usablePercent ?? null,
    }
  }

  const nextAvailableAt = plan.nextAvailable
    ? new Date(plan.nextAvailable.at).toISOString()
    : null

  if (current) {
    return {
      accountId: current.id,
      nextAvailableAt,
      reason: 'exhausted',
      usablePercent: currentUsable,
    }
  }

  const fallback =
    accounts.find((account) => account.id === plan.nextAvailable?.accountId) ??
    accounts[0] ??
    null

  return {
    accountId: fallback?.id ?? null,
    nextAvailableAt,
    reason: fallback ? 'exhausted' : 'initial',
    usablePercent: fallback ? usablePercent(fallback) : null,
  }
}

export function usablePercent(account: ResetPlanAccount) {
  const known = getRateLimitWindows(account)
    .map((window) => window.remainingPercent)
    .filter((value): value is number => value != null)

  return known.length > 0 ? Math.min(...known) : null
}

export function serializePoolDecision(decision: PoolDecision) {
  return {
    nextAvailableAt: decision.nextAvailableAt,
    reason: decision.reason,
    usablePercent: decision.usablePercent,
  }
}
