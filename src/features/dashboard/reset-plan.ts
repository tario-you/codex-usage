import { isClaudeAccountKey } from '../../shared/codex.js'
import {
  getCurrentRateLimitWindows,
  isWeeklyWindowSpent,
  type RateLimitWindowKey,
  type RateLimitWindowSource,
} from '../../shared/rate-limit-windows.js'

import { planEndsAt } from './plan-end.js'
import { comparePlansForUse, isUsablePlan, planEligible, resetPriority, useGroup, type UsePlan } from '../../../bin/lib/plan-order.js'

interface NormalizedResetWindow {
  key: RateLimitWindowKey
  label: string
  remainingPercent: number | null
  resetsAt: number | null
  windowDurationMins: number | null
}

interface NormalizedResetAccount {
  usageKind?: string
  cancelled: boolean
  accessLost: boolean
  connectionStatus: string | null
  checkedAt: number | null
  endsAt: number | null
  id: string
  label: string
  windows: NormalizedResetWindow[]
  planType: string | null
  credits: number
  provider: number
}

export interface ResetPlanRecommendation {
  accountId: string
  accountLabel: string
  /** When this plan's usable room is lost: its next reset or its end, whichever is sooner. */
  expiresAt: number | null
  limitingWindowLabel: string | null
  nextResetAt: number | null
  nextResetWindowLabel: string | null
  planEndsAt: number | null
  usablePercent: number
}

export interface ResetPlanEvent {
  accountId: string
  accountLabel: string
  at: number
  projectedUsablePercent: number | null
  windowKey: RateLimitWindowKey
  windowLabel: string
}

export interface ResetPlan {
  current: ResetPlanRecommendation | null
  fallbacks: ResetPlanRecommendation[]
  nextAvailable: ResetPlanEvent | null
  upcomingResets: ResetPlanEvent[]
  resetFallbacks: Array<{ accountId: string; accountLabel: string; savedMs: number }>
}

export interface ResetPlanAccount extends RateLimitWindowSource {
  account_key: string
  email: string | null
  id: string
  label: string | null
  /** When the owner says the plan stops working; null or absent when unknown. */
  plan_ends_at?: string | null
  plan_type?: string | null
  raw_rate_limits?: unknown
  last_snapshot_at?: string | null
  connection_status?: string | null
  access_lost?: boolean
  metadata?: unknown
}

export function buildResetPlan(
  accounts: ResetPlanAccount[],
  now = Date.now(),
): ResetPlan {
  // The plan answers "which Codex login now"; a Claude row is a different
  // product and never a switch target, so it stays out of the ordering. A plan
  // that has ended is no target either.
  const normalizedAccounts = accounts
    .filter((account) => !isClaudeAccountKey(account.account_key) && planEligible(account.plan_type) !== false)
    .map((account) => normalizeAccount(account, now))
    .filter((account) => isUsablePlan(orderPlan(account), now))
    .sort((a, b) => comparePlansForUse(orderPlan(a), orderPlan(b), now))
  const recommendations = normalizedAccounts
    .map(buildRecommendation)
    .filter(
      (recommendation): recommendation is ResetPlanRecommendation =>
        recommendation !== null,
    )

  const upcomingResets = buildUpcomingResets(normalizedAccounts)

  return {
    resetFallbacks: normalizedAccounts.filter(account => useGroup(orderPlan(account), now) === 1)
      .map(account => ({ accountId: account.id, accountLabel: account.label, savedMs: resetPriority(orderPlan(account), now).savedMs })),
    current: recommendations[0] ?? null,
    fallbacks: recommendations.slice(1),
    nextAvailable:
      recommendations.length === 0
        ? findNextAvailableReset(normalizedAccounts, upcomingResets)
        : null,
    upcomingResets,
  }
}

/** Table and automatic recovery read the same portable quota/reset order. */
export function orderAccountsForUse<T extends ResetPlanAccount>(accounts: T[], now = Date.now()): T[] {
  return accounts.map((account, index) => ({ account, index, plan: orderPlan(normalizeAccount(account, now)) }))
    .filter(({ plan }) => isUsablePlan(plan, now))
    .sort((a, b) => comparePlansForUse(a.plan, b.plan, now) || a.index - b.index)
    .map(({ account }) => account)
}

/**
 * Why a row the shared order leaves out is out, in words, from the same fields
 * `isUsablePlan` reads (plan-order.js stays byte-identical for the switcher).
 * Null when the row is usable. A grey row never reads like spare room.
 */
export function unusableReason(account: ResetPlanAccount, now: number): string | null {
  const normalized = normalizeAccount(account, now)
  const plan = orderPlan(normalized)
  if (isUsablePlan(plan, now)) return null
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (plan.accessLost) return 'access lost: not counted'
  if (plan.connectionStatus != null && plan.connectionStatus !== 'connected') return 'signed out: not counted'
  const endsAt = normalized.endsAt
  if (endsAt != null && endsAt <= now) return 'plan ended: not counted'
  if (plan.cancelled) return 'cancelled: not counted'
  if (endsAt != null && plan.exhausted) {
    return plan.returnsAt != null
      ? `used up; ends ${day(endsAt)} before its reset on ${day(plan.returnsAt)}: no room left`
      : `used up; ends ${day(endsAt)}: no room left`
  }
  if (plan.checkedAt != null) {
    const hours = Math.round((now - plan.checkedAt) / 3_600_000)
    const mark = (account.metadata as { auto_switch?: { in_pool?: unknown } } | null | undefined)?.auto_switch
    const outOfPool = mark?.in_pool === false ? ', kept out of switching' : ''
    return `last read ${hours}h ago${outOfPool}: room unknown, not counted`
  }
  return 'not counted'
}

export function isAccountUsableForUse(account: ResetPlanAccount, now: number): boolean {
  return isUsablePlan(orderPlan(normalizeAccount(account, now)), now)
}

function orderPlan(account: NormalizedResetAccount): UsePlan {
  const recommendation = buildRecommendation(account)
  const spent = account.windows.filter(window => window.remainingPercent != null && window.remainingPercent <= 0)
  const returnsAt = spent.length && spent.every(window => window.resetsAt != null)
    ? Math.max(...spent.map(window => window.resetsAt!)) : null
  return {
    cancelled: account.cancelled,
    accessLost: account.accessLost,
    connectionStatus: account.connectionStatus,
    checkedAt: account.checkedAt,
    available: recommendation != null,
    exhausted: account.usageKind === 'exhausted' || spent.length > 0,
    weeklySpent: isWeeklyWindowSpent(spent),
    credits: account.credits,
    endsAt: account.endsAt,
    expiresAt: recommendation?.expiresAt ?? null,
    returnsAt,
    usablePercent: recommendation?.usablePercent ?? null,
    label: account.label,
    planType: account.planType,
    provider: account.provider,
  }
}

function normalizeAccount(
  account: ResetPlanAccount,
  now: number,
): NormalizedResetAccount {
  const raw = account.raw_rate_limits as { resetCredits?: { applicable?: number | null; available?: number }; subscription?: { cancelled?: boolean; endsAt?: number | null }; connection?: { status?: string; checkedAt?: number; accessLost?: boolean; usageKind?: string } } | null
  const expiresAt = Number.isFinite(raw?.subscription?.endsAt) ? raw!.subscription!.endsAt! * 1000 : null
  const subscriptionEnd = planEligible(account.plan_type) === true && expiresAt != null && (expiresAt <= now || raw?.subscription?.cancelled === true) ? expiresAt : null
  const endsAt = earliest(planEndsAt(account), subscriptionEnd)
  return {
    usageKind: raw?.connection?.usageKind,
    cancelled: raw?.subscription?.cancelled === true,
    accessLost: account.access_lost === true || raw?.connection?.accessLost === true,
    connectionStatus: raw?.connection?.status ?? account.connection_status ?? null,
    checkedAt: raw?.connection?.checkedAt ?? (Number.isFinite(Date.parse(account.last_snapshot_at ?? '')) ? Date.parse(account.last_snapshot_at!) : null),
    endsAt,
    planType: account.plan_type ?? null,
    credits: isClaudeAccountKey(account.account_key) ? 0 : raw?.resetCredits?.applicable ?? raw?.resetCredits?.available ?? 0,
    provider: isClaudeAccountKey(account.account_key) ? 1 : 0,
    id: account.id,
    label: account.label ?? account.email ?? account.account_key,
    windows: getCurrentRateLimitWindows(account, now).map((window) => {
      const resetsAt = parseFutureTimestamp(window.resetsAt, now)
      return {
        key: window.key,
        label: window.label,
        remainingPercent: window.remainingPercent,
        resetsAt,
        windowDurationMins: window.windowDurationMins,
      }
    }),
  }
}

function buildRecommendation(
  account: NormalizedResetAccount,
): ResetPlanRecommendation | null {
  if (account.usageKind === 'exhausted' || account.usageKind === 'unknown') return null
  const usablePercent = getUsablePercent(
    account.windows.map((window) => window.remainingPercent),
  )
  if (usablePercent == null || usablePercent <= 0) {
    return null
  }

  const limitingWindow = account.windows
    .filter((window) => window.remainingPercent != null)
    .sort(
      (left, right) =>
        (left.remainingPercent ?? Number.POSITIVE_INFINITY) -
        (right.remainingPercent ?? Number.POSITIVE_INFINITY),
    )[0]
  const nextReset = account.windows
    .filter((window) => window.resetsAt != null)
    .sort(
      (left, right) =>
        (left.resetsAt ?? Number.POSITIVE_INFINITY) -
        (right.resetsAt ?? Number.POSITIVE_INFINITY),
    )[0]

  const nextResetAt = nextReset?.resetsAt ?? null
  return {
    accountId: account.id,
    accountLabel: account.label,
    expiresAt: earliest(nextResetAt, account.endsAt),
    limitingWindowLabel: limitingWindow?.label ?? null,
    nextResetAt,
    nextResetWindowLabel: nextReset?.label ?? null,
    planEndsAt: account.endsAt,
    usablePercent,
  }
}

function earliest(left: number | null, right: number | null) {
  if (left == null) return right
  if (right == null) return left
  return Math.min(left, right)
}

function buildUpcomingResets(accounts: NormalizedResetAccount[]) {
  const state = new Map(
    accounts.map((account) => [
      account.id,
      Object.fromEntries(
        account.windows.map((window) => [window.key, window.remainingPercent]),
      ) as Partial<Record<RateLimitWindowKey, number | null>>,
    ]),
  )
  const resetWindows = accounts
    .flatMap((account) =>
      account.windows.flatMap((window) =>
        window.resetsAt == null || (account.endsAt != null && window.resetsAt >= account.endsAt)
          ? []
          : [{ account, at: window.resetsAt, window }],
      ),
    )
    .sort((left, right) => {
      const timeDifference = left.at - right.at
      if (timeDifference !== 0) {
        return timeDifference
      }

      return left.account.label.localeCompare(right.account.label)
    })

  return resetWindows.map(({ account, at, window }) => {
    const accountState = state.get(account.id)
    if (accountState) {
      accountState[window.key] = 100
    }

    return {
      accountId: account.id,
      accountLabel: account.label,
      at,
      projectedUsablePercent: accountState
        ? getUsablePercent(Object.values(accountState))
        : null,
      windowKey: window.key,
      windowLabel: window.label,
    }
  })
}

function findNextAvailableReset(
  accounts: NormalizedResetAccount[],
  events: ResetPlanEvent[],
) {
  const accountById = new Map(accounts.map((account) => [account.id, account]))

  return (
    events.find((event) => {
      const account = accountById.get(event.accountId)
      if (!account || event.projectedUsablePercent == null) {
        return false
      }

      const currentUsablePercent = getUsablePercent(
        account.windows.map((window) => window.remainingPercent),
      )
      return currentUsablePercent === 0 && event.projectedUsablePercent > 0
    }) ?? null
  )
}

function getUsablePercent(values: Array<number | null | undefined>) {
  const knownValues = values.filter((value): value is number => value != null)
  return knownValues.length > 0 ? Math.min(...knownValues) : null
}

function parseFutureTimestamp(value: string | null, now: number) {
  if (!value) {
    return null
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > now ? parsed : null
}
