import { formatWindowLabel } from '@/shared/codex'

type ResetWindowKey = 'primary' | 'secondary'

interface NormalizedResetWindow {
  key: ResetWindowKey
  label: string
  remainingPercent: number | null
  resetsAt: number | null
}

interface NormalizedResetAccount {
  id: string
  label: string
  windows: [NormalizedResetWindow, NormalizedResetWindow]
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
  windowKey: ResetWindowKey
  windowLabel: string
}

export interface ResetPlan {
  current: ResetPlanRecommendation | null
  fallbacks: ResetPlanRecommendation[]
  nextAvailable: ResetPlanEvent | null
  upcomingResets: ResetPlanEvent[]
}

export interface ResetPlanAccount {
  account_key: string
  email: string | null
  id: string
  label: string | null
  primary_remaining_percent: number | null
  primary_resets_at: string | null
  primary_window_mins: number | null
  secondary_remaining_percent: number | null
  secondary_resets_at: string | null
  secondary_window_mins: number | null
}

export function buildResetPlan(
  accounts: ResetPlanAccount[],
  now = Date.now(),
): ResetPlan {
  const normalizedAccounts = accounts.map((account) =>
    normalizeAccount(account, now),
  )
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

function normalizeAccount(
  account: ResetPlanAccount,
  now: number,
): NormalizedResetAccount {
  return {
    id: account.id,
    label: account.label ?? account.email ?? account.account_key,
    windows: [
      {
        key: 'primary',
        label: formatWindowLabel(account.primary_window_mins),
        remainingPercent: clampPercent(account.primary_remaining_percent),
        resetsAt: parseFutureTimestamp(account.primary_resets_at, now),
      },
      {
        key: 'secondary',
        label: formatWindowLabel(account.secondary_window_mins),
        remainingPercent: clampPercent(account.secondary_remaining_percent),
        resetsAt: parseFutureTimestamp(account.secondary_resets_at, now),
      },
    ],
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
  if (resetDifference !== 0) {
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
      {
        primary: account.windows[0].remainingPercent,
        secondary: account.windows[1].remainingPercent,
      },
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
        ? getUsablePercent([accountState.primary, accountState.secondary])
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

function getUsablePercent(values: Array<number | null>) {
  const knownValues = values.filter((value): value is number => value != null)
  return knownValues.length > 0 ? Math.min(...knownValues) : null
}

function clampPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return null
  }

  return Math.max(0, Math.min(100, value))
}

function parseFutureTimestamp(value: string | null, now: number) {
  if (!value) {
    return null
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > now ? parsed : null
}
