import { queryOptions } from '@tanstack/react-query'

import type { Database } from './database.types'
import {
  getDashboardWeeklyUsageBucketSeconds,
  getDashboardWeeklyUsageRangeDays,
  type DashboardWeeklyUsageRange,
} from '../features/dashboard/usage-history-ranges'
import { clientEnvError } from './env'
import { supabase } from './supabase'
import {
  getRemainingPercent,
  isClaudeAccountKey,
  isFreshTimestamp,
  type CodexRateLimitSnapshot,
} from '@/shared/codex'
import { getRateLimitWindows } from '@/shared/rate-limit-windows'

export type DashboardAccountRow =
  Database['public']['Views']['codex_dashboard_accounts']['Row']
export type DashboardInviterRow =
  Database['public']['Functions']['list_dashboard_inviters']['Returns'][number]

type DashboardWeeklyUsageHistoryRpcRow =
  Database['public']['Functions']['list_dashboard_provider_weekly_usage_history']['Returns'][number]

export {
  POSTGREST_MAX_ROWS,
  dashboardWeeklyUsageRanges,
  getDashboardWeeklyUsageBucketSeconds,
  getDashboardWeeklyUsageRangeDays,
  type DashboardWeeklyUsageRange,
} from '../features/dashboard/usage-history-ranges'

export type UsageProvider = 'codex' | 'claude'

export interface DashboardWeeklyUsageHistoryPoint {
  provider: UsageProvider
  accountCount: number
  fetchedAt: string
  totalCapacityPercent: number
  totalRemainingPercent: number
}

export interface ModelBucket {
  key: string
  label: string
  planType: string | null
  primaryRemaining: number | null
  primaryResetsAt: number | null
  primaryUsed: number | null
  secondaryRemaining: number | null
  secondaryResetsAt: number | null
  secondaryUsed: number | null
}

export interface DashboardSummary {
  accountsTracked: number
  lowBalanceCount: number
  mostRecentSync: string | null
  staleAccounts: number
}

export function dashboardAccountsQueryOptions(userId: string) {
  return queryOptions({
    queryKey: ['dashboard-accounts', userId],
    queryFn: fetchDashboardAccounts,
    refetchInterval: 30_000,
  })
}

export function dashboardInvitersQueryOptions(userId: string) {
  return queryOptions({
    queryKey: ['dashboard-inviters', userId],
    queryFn: fetchDashboardInviters,
    refetchInterval: 30_000,
  })
}

export function dashboardWeeklyUsageHistoryQueryOptions(
  userId: string,
  range: DashboardWeeklyUsageRange,
) {
  return queryOptions({
    queryKey: ['dashboard-provider-weekly-usage-history', userId, range],
    queryFn: () => fetchDashboardWeeklyUsageHistory(range),
    refetchInterval: 30_000,
  })
}

export async function fetchDashboardAccounts() {
  if (!supabase) {
    throw new Error(
      clientEnvError ??
        'Supabase env vars are missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    )
  }

  const { data, error } = await supabase
    .from('codex_dashboard_accounts')
    .select('*')
    .order('last_snapshot_at', { ascending: false, nullsFirst: false })
    .returns<DashboardAccountRow[]>()

  if (error) {
    throw new Error(error.message)
  }

  return (data ?? []).map(normalizeDashboardAccountRow)
}

export async function fetchDashboardInviters() {
  if (!supabase) {
    throw new Error(
      clientEnvError ??
        'Supabase env vars are missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    )
  }

  const { data, error } = await supabase
    .rpc('list_dashboard_inviters')
    .returns<DashboardInviterRow[]>()

  if (error) {
    throw new Error(error.message)
  }

  return data ?? []
}

export async function fetchDashboardWeeklyUsageHistory(
  range: DashboardWeeklyUsageRange,
) {
  if (!supabase) {
    throw new Error(
      clientEnvError ??
        'Supabase env vars are missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    )
  }

  const rangeStart = new Date(
    Date.now() - getDashboardWeeklyUsageRangeDays(range) * 24 * 60 * 60 * 1000,
  ).toISOString()

  const client = supabase
  const histories = await Promise.all((['codex', 'claude'] as const).map(async (provider) => {
    const { data, error } = await client
      .rpc('list_dashboard_provider_weekly_usage_history', {
        bucket_seconds: getDashboardWeeklyUsageBucketSeconds(range),
        range_start: rangeStart,
        usage_provider: provider,
      })
      .returns<DashboardWeeklyUsageHistoryRpcRow[]>()
    if (error) throw new Error(error.message)
    return (data ?? []).map((row) => mapWeeklyUsageHistoryRow(row, provider))
  }))
  return histories.flat()
}

/** A Claude login reported beside the Codex ones; its key is `claude:<email>`. */
export function isClaudeAccount(row: Pick<DashboardAccountRow, 'account_key'>) {
  return isClaudeAccountKey(row.account_key)
}

const MAIN_LIMIT_IDS = new Set(['codex', 'claude'])

export function getModelBuckets(row: DashboardAccountRow) {
  const rawBuckets = row.raw_rate_limits_by_limit_id
  if (!rawBuckets || typeof rawBuckets !== 'object' || Array.isArray(rawBuckets)) {
    return [] as ModelBucket[]
  }

  return Object.entries(
    rawBuckets as Record<string, CodexRateLimitSnapshot | undefined>,
  )
    .filter(([, snapshot]) => snapshot && !MAIN_LIMIT_IDS.has(snapshot.limitId ?? ''))
    .map(([key, snapshot]) => ({
      key,
      label: snapshot?.limitName ?? key,
      planType: snapshot?.planType ?? null,
      primaryRemaining: getRemainingPercent(snapshot?.primary?.usedPercent),
      primaryResetsAt: snapshot?.primary?.resetsAt ?? null,
      primaryUsed: snapshot?.primary?.usedPercent ?? null,
      secondaryRemaining: getRemainingPercent(snapshot?.secondary?.usedPercent),
      secondaryResetsAt: snapshot?.secondary?.resetsAt ?? null,
      secondaryUsed: snapshot?.secondary?.usedPercent ?? null,
    }))
    .sort((left, right) => {
      const leftScore = left.secondaryRemaining ?? left.primaryRemaining ?? -1
      const rightScore = right.secondaryRemaining ?? right.primaryRemaining ?? -1
      return rightScore - leftScore
    })
}


export function buildSummary(rows: DashboardAccountRow[]): DashboardSummary {
  const mostRecentSync = rows
    .map((row) => row.last_snapshot_at)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null

  return {
    accountsTracked: rows.length,
    lowBalanceCount: rows.filter((row) =>
      getRateLimitWindows(row).some(
        (window) =>
          window.remainingPercent != null && window.remainingPercent <= 20,
      ),
    ).length,
    mostRecentSync,
    staleAccounts: rows.filter((row) => !isFreshTimestamp(row.last_snapshot_at))
      .length,
  }
}

function normalizeDashboardAccountRow(row: DashboardAccountRow) {
  return {
    ...row,
    primary_remaining_percent:
      row.primary_used_percent == null
        ? null
        : getRemainingPercent(row.primary_used_percent),
    secondary_remaining_percent:
      row.secondary_used_percent == null
        ? null
        : getRemainingPercent(row.secondary_used_percent),
  }
}

function mapWeeklyUsageHistoryRow(
  row: DashboardWeeklyUsageHistoryRpcRow,
  provider: UsageProvider,
): DashboardWeeklyUsageHistoryPoint {
  return {
    provider,
    accountCount: row.account_count,
    fetchedAt: row.fetched_at,
    totalCapacityPercent: row.total_capacity_percent,
    totalRemainingPercent: row.total_remaining_percent,
  }
}
