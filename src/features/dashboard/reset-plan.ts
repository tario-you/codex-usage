import { isClaudeAccountKey } from '../../shared/codex.js'
import {
  getCurrentRateLimitWindows,
  isWeeklyWindowSpent,
  type RateLimitWindowKey,
  type RateLimitWindowSource,
} from '../../shared/rate-limit-windows.js'

interface NormalizedResetWindow {
  key: RateLimitWindowKey
  label: string
  remainingPercent: number | null
  resetsAt: number | null
  windowDurationMins: number | null
}

interface NormalizedResetAccount {
  id: string
  label: string
  windows: NormalizedResetWindow[]
}

export interface ResetPlanRecommendation {
  accountId: string
  accountLabel: string
  limitingWindowLabel: string | null
  nextResetAt: number | null
  nextResetWindowLabel: string | null
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
}

export interface ResetPlanAccount extends RateLimitWindowSource {
  account_key: string
  email: string | null
  id: string
  label: string | null
}

export function buildResetPlan(
  accounts: ResetPlanAccount[],
  now = Date.now(),
): ResetPlan {
  // The plan answers "which Codex login now"; a Claude row is a different
  // product and never a switch target, so it stays out of the ordering.
  const normalizedAccounts = accounts
    .filter((account) => !isClaudeAccountKey(account.account_key))
    .map((account) => normalizeAccount(account, now))
  const recommendations = normalizedAccounts
    .map(buildRecommendation)
    .filter(
      (recommendation): recommendation is ResetPlanRecommendation =>
        recommendation !== null,
    )
    .sort(compareRecommendations)
  const upcomingResets = buildUpcomingResets(normalizedAccounts)

  return {
    current: recommendations[0] ?? null,
    fallbacks: recommendations.slice(1),
    nextAvailable:
      recommendations.length === 0
        ? findNextAvailableReset(normalizedAccounts, upcomingResets)
        : null,
    upcomingResets,
  }
}

const USE_GROUP = { usable: 0, waiting: 1, unknown: 2, weeklySpent: 3 } as const

/**
 * Order the table by what to use next, without changing the saved rows:
 * allowance usable now in the recommendation order, then rows waiting on a
 * spent 5-hour window, then unknown balances, then rows whose weekly
 * allowance is spent, since those stay unusable for days. Codex rows lead
 * Claude rows within each group; Claude rows never enter the Codex plan.
 */
export function orderAccountsForUse<T extends ResetPlanAccount>(accounts: T[], now = Date.now()): T[] {
  return accounts
    .map((account, index) => ({ account, index, ...rankForUse(account, now) }))
    .sort(
      (left, right) =>
        left.group - right.group ||
        left.provider - right.provider ||
        (left.recommendation && right.recommendation
          ? compareRecommendations(left.recommendation, right.recommendation)
          : 0) ||
        (left.backAt === right.backAt ? 0 : left.backAt - right.backAt) ||
        left.index - right.index,
    )
    .map(({ account }) => account)
}

function rankForUse(account: ResetPlanAccount, now: number) {
  const normalized = normalizeAccount(account, now)
  const recommendation = buildRecommendation(normalized)
  const spent = normalized.windows.filter(
    (window) => window.remainingPercent != null && window.remainingPercent <= 0,
  )
  const group = recommendation
    ? USE_GROUP.usable
    : spent.length === 0
      ? USE_GROUP.unknown
      : isWeeklyWindowSpent(spent)
        ? USE_GROUP.weeklySpent
        : USE_GROUP.waiting

  return {
    // Usable again once every spent window has reset; an unknown reset sorts last.
    backAt: Math.max(
      Number.NEGATIVE_INFINITY,
      ...spent.map((window) => window.resetsAt ?? Number.POSITIVE_INFINITY),
    ),
    group,
    provider: isClaudeAccountKey(account.account_key) ? 1 : 0,
    recommendation,
  }
}

function normalizeAccount(
  account: ResetPlanAccount,
  now: number,
): NormalizedResetAccount {
  return {
    id: account.id,
    label: account.label ?? account.email ?? account.account_key,
    windows: getCurrentRateLimitWindows(account, now).map((window) => ({
      key: window.key,
      label: window.label,
      remainingPercent: window.remainingPercent,
      resetsAt: parseFutureTimestamp(window.resetsAt, now),
      windowDurationMins: window.windowDurationMins,
    })),
  }
}

function buildRecommendation(
  account: NormalizedResetAccount,
): ResetPlanRecommendation | null {
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

  return {
    accountId: account.id,
    accountLabel: account.label,
    limitingWindowLabel: limitingWindow?.label ?? null,
    nextResetAt: nextReset?.resetsAt ?? null,
    nextResetWindowLabel: nextReset?.label ?? null,
    usablePercent,
  }
}

function compareRecommendations(
  left: ResetPlanRecommendation,
  right: ResetPlanRecommendation,
) {
  const resetDifference =
    (left.nextResetAt ?? Number.POSITIVE_INFINITY) -
    (right.nextResetAt ?? Number.POSITIVE_INFINITY)
  if (left.nextResetAt !== right.nextResetAt) {
    return resetDifference
  }

  const balanceDifference = right.usablePercent - left.usablePercent
  if (balanceDifference !== 0) {
    return balanceDifference
  }

  return left.accountLabel.localeCompare(right.accountLabel)
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
        window.resetsAt == null
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
