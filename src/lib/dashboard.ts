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

async function fetchDashboardAccounts() {
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

async function fetchDashboardInviters() {
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
