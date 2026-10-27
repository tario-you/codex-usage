import { queryOptions } from '@tanstack/react-query'

import type { Database } from './database.types'
import {
  POSTGREST_MAX_ROWS,
  getDashboardWeeklyUsageBucketSeconds,
  getDashboardWeeklyUsageRangeDays,
  type DashboardWeeklyUsageRange,
} from '../features/dashboard/usage-history-ranges'
import { cachedQuery } from './dashboard-cache'
import { clientEnvError } from './env'
import { supabase } from './supabase'
import { dropUncountedPlans, type PlanReading, type UncountedPlan } from './uncounted-history'
import {
  getRemainingPercent,
  isClaudeAccountKey,
  isFreshTimestamp,
  isSyncStopped,
  type CodexRateLimitSnapshot,
} from '@/shared/codex'
import { getRateLimitWindows } from '@/shared/rate-limit-windows'

export type DashboardAccountRow =
  Database['public']['Views']['codex_dashboard_accounts']['Row']
export type DashboardInviterRow =
  Database['public']['Functions']['list_dashboard_inviters']['Returns'][number]

type DashboardWeeklyUsageHistoryRpcRow =
  Database['public']['Functions']['list_dashboard_usage_history']['Returns'][number]

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
  /** Weekly room usable now: plans whose 5-hour window is spent count none until it resets. */
  effectiveRemainingPercent?: number | null
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
  /** The newest reading of any account is over an hour old: the uploader has stopped. */
  syncStopped: boolean
}

export function dashboardAccountsQueryOptions(userId: string) {
  return queryOptions({
    queryKey: ['dashboard-accounts', userId],
    ...cachedQuery(userId === 'guest' ? null : `accounts.${userId}`, fetchDashboardAccounts),
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

// her-team#15046: `uncounted`, the plans the rows' shared order leaves out (orderAccountsForUse), leave the chart too.
export function dashboardWeeklyUsageHistoryQueryOptions(
  userId: string,
  range: DashboardWeeklyUsageRange,
  uncounted: UncountedPlan[],
) {
  const plans = [...uncounted].sort((a, b) => a.id.localeCompare(b.id))
  return queryOptions({
    queryKey: ['dashboard-weighted-weekly-usage-history', userId, range, plans.map((plan) => plan.id)],
    ...cachedQuery(userId === 'guest' ? null : `history.${userId}.${range}`, () => fetchDashboardWeeklyUsageHistory(range, plans)),
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
  uncounted: UncountedPlan[] = [],
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
      .rpc('list_dashboard_usage_history', {
        bucket_seconds: getDashboardWeeklyUsageBucketSeconds(range),
        range_start: rangeStart,
        usage_provider: provider,
      })
      .returns<DashboardWeeklyUsageHistoryRpcRow[]>()
    if (error) throw new Error(error.message)
    const points = (data ?? []).map((row) => mapWeeklyUsageHistoryRow(row, provider))
    const plans = uncounted.filter((plan) => (isClaudeAccountKey(plan.account_key) ? 'claude' : 'codex') === provider)
    if (plans.length === 0) return points
    const readings = (await Promise.all(plans.map((plan) => readPlanReadings(client, plan.id, rangeStart)))).flat()
    return dropUncountedPlans(points, provider, plans, readings)
  }))
  return histories.flat()
}

const READING_COLUMNS =
  'id, account_id, fetched_at, primary_used_percent, primary_window_mins, secondary_used_percent, secondary_window_mins, plan_type:raw_rate_limits->>planType'

/** An uncounted plan's readings, kept per plan: once read from a range start, each refresh asks only for newer rows. */
const keptReadings = new Map<string, { from: string; rows: PlanReading[] }>()

async function readPlanReadings(client: NonNullable<typeof supabase>, accountId: string, rangeStart: string) {
  const kept = keptReadings.get(accountId)
  const rows: PlanReading[] = []
  let since = rangeStart
  if (kept && kept.from <= rangeStart) {
    rows.push(...kept.rows)
    since = kept.rows.at(-1)?.fetched_at ?? kept.from
  } else {
    // The last reading before the range carries the plan's room into its first points.
    const { data, error } = await client.from('codex_usage_snapshots').select(READING_COLUMNS)
      .eq('account_id', accountId).lt('fetched_at', rangeStart)
      .order('fetched_at', { ascending: false }).order('id', { ascending: false }).limit(1)
      .returns<PlanReading[]>()
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
  }
  const seen = new Set(rows.map((row) => row.id))
  for (let offset = 0; ; offset += POSTGREST_MAX_ROWS) {
    const { data, error } = await client.from('codex_usage_snapshots').select(READING_COLUMNS)
      .eq('account_id', accountId).gte('fetched_at', since)
      .order('fetched_at', { ascending: true }).order('id', { ascending: true })
      .range(offset, offset + POSTGREST_MAX_ROWS - 1)
      .returns<PlanReading[]>()
    if (error) throw new Error(error.message)
    for (const row of data ?? []) if (!seen.has(row.id)) rows.push(row)
    if ((data ?? []).length < POSTGREST_MAX_ROWS) break
  }
  // Rows before the range go, all but the last, which still carries the plan's room into the range.
  const start = Date.parse(rangeStart)
  let first = 0
  rows.forEach((row, index) => { if (Date.parse(row.fetched_at) < start) first = index })
  const current = rows.slice(first)
  keptReadings.set(accountId, { from: rangeStart, rows: current })
  return current
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
    syncStopped: isSyncStopped(mostRecentSync, rows.length),
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
    effectiveRemainingPercent: row.effective_remaining_percent,
  }
}
