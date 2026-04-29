import { queryOptions } from '@tanstack/react-query'

import type { Database } from './database.types'
import { clientEnvError } from './env'
import { supabase } from './supabase'
import {
  getRemainingPercent,
  isFreshTimestamp,
  type CodexRateLimitSnapshot,
} from '@/shared/codex'

export type DashboardAccountRow =
  Database['public']['Views']['codex_dashboard_accounts']['Row']
export type DashboardInviterRow =
  Database['public']['Functions']['list_dashboard_inviters']['Returns'][number]

type DashboardWeeklyUsageHistoryRpcRow =
  Database['public']['Functions']['list_dashboard_weekly_usage_history']['Returns'][number]

export const dashboardWeeklyUsageRanges = [
  { days: 1, label: '1 day', value: '1d' },
  { days: 7, label: '7 day', value: '7d' },
  { days: 30, label: '30 day', value: '30d' },
] as const

export type DashboardWeeklyUsageRange =
  (typeof dashboardWeeklyUsageRanges)[number]['value']

export interface DashboardWeeklyUsageHistoryPoint {
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
    queryKey: ['dashboard-weekly-usage-history', userId, range],
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

  return data ?? []
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

  const { data, error } = await supabase
    .rpc('list_dashboard_weekly_usage_history', {
      range_start: rangeStart,
    })
    .returns<DashboardWeeklyUsageHistoryRpcRow[]>()

  if (error) {
    throw new Error(error.message)
  }

  return (data ?? []).map(mapWeeklyUsageHistoryRow)
}

export function getModelBuckets(row: DashboardAccountRow) {
  const rawBuckets = row.raw_rate_limits_by_limit_id
  if (!rawBuckets || typeof rawBuckets !== 'object' || Array.isArray(rawBuckets)) {
    return [] as ModelBucket[]
  }

  return Object.entries(
    rawBuckets as Record<string, CodexRateLimitSnapshot | undefined>,
  )
    .filter(([, snapshot]) => snapshot && snapshot.limitId !== 'codex')
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

export function getDashboardWeeklyUsageRangeDays(
  range: DashboardWeeklyUsageRange,
) {
  return (
    dashboardWeeklyUsageRanges.find((option) => option.value === range)?.days ?? 7
  )
}

export function buildSummary(rows: DashboardAccountRow[]): DashboardSummary {
  const mostRecentSync = rows
    .map((row) => row.last_snapshot_at)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null

  return {
    accountsTracked: rows.length,
    lowBalanceCount: rows.filter((row) => {
      const primary = row.primary_remaining_percent ?? 100
      const secondary = row.secondary_remaining_percent ?? 100
      return primary <= 20 || secondary <= 20
    }).length,
    mostRecentSync,
    staleAccounts: rows.filter((row) => !isFreshTimestamp(row.last_snapshot_at))
      .length,
  }
}

function mapWeeklyUsageHistoryRow(
  row: DashboardWeeklyUsageHistoryRpcRow,
): DashboardWeeklyUsageHistoryPoint {
  return {
    accountCount: row.account_count,
    fetchedAt: row.fetched_at,
    totalCapacityPercent: row.total_capacity_percent,
    totalRemainingPercent: row.total_remaining_percent,
  }
}
