// her-team#15046: the chart totals the plans the rows count, never a grey one. The history RPC sums every
// plan's last reading per time bucket; the dashboard takes each plan its shared order leaves out
// (reset-plan.ts orderAccountsForUse) back out, from that plan's own readings and the RPC's own arithmetic,
// so the chart, the rows and the switcher read one list. Pure, so tests import it without Supabase.

type UsageProvider = 'codex' | 'claude'

/** A history point as dashboard.ts maps it from `list_dashboard_usage_history`. */
export interface HistoryPoint {
  accountCount: number
  fetchedAt: string
  totalCapacityPercent: number
  totalRemainingPercent: number
  effectiveRemainingPercent?: number | null
}

export interface UncountedPlan {
  id: string
  account_key: string
  plan_type: string | null
}

export interface PlanReading {
  id: number
  account_id: string
  fetched_at: string
  primary_used_percent: number | null
  primary_window_mins: number | null
  secondary_used_percent: number | null
  secondary_window_mins: number | null
  primary_resets_at?: string | null
  secondary_resets_at?: string | null
  /** The reading's own `raw_rate_limits->>planType`. */
  plan_type: string | null
}

const WEEK_MINS = 10080
const SESSION_MINS = 300

/** A window's room at `at`: full once its reset has passed, as the history SQL counts it. */
function windowRoom(used: number, resetsAt: string | null | undefined, at: number) {
  const reset = Date.parse(resetsAt ?? '')
  return Number.isFinite(reset) && reset <= at ? 100 : Math.max(0, Math.min(100, 100 - used))
}

function room(reading: PlanReading | undefined, windowMins: number, at: number): number | null {
  if (!reading) return null
  if (reading.primary_window_mins === windowMins && reading.primary_used_percent != null) {
    return windowRoom(reading.primary_used_percent, reading.primary_resets_at, at)
  }
  if (reading.secondary_window_mins === windowMins && reading.secondary_used_percent != null) {
    return windowRoom(reading.secondary_used_percent, reading.secondary_resets_at, at)
  }
  return null
}

/** The RPC's weight: a Codex ProLite counts a quarter of a plan. */
function weight(provider: UsageProvider, plan: UncountedPlan, reading: PlanReading | undefined) {
  const planType = (reading?.plan_type?.trim() || plan.plan_type || '').trim().toLowerCase()
  return provider === 'codex' && planType === 'prolite' ? 0.25 : 1
}

function round(value: number) {
  return Math.round(value * 1e6) / 1e6
}

/**
 * Each point less the uncounted plans' share of it: weekly room from each plan's last reading at or before the
 * point, its capacity and one plan of the count, as `list_dashboard_usage_history` added them. A point with no
 * counted plan left is dropped.
 */
export function dropUncountedPlans<T extends HistoryPoint>(
  points: T[],
  provider: UsageProvider,
  plans: UncountedPlan[],
  readings: PlanReading[],
): T[] {
  if (plans.length === 0) return points
  const byPlan = new Map(plans.map((plan) => [plan.id, [] as PlanReading[]]))
  for (const reading of readings) byPlan.get(reading.account_id)?.push(reading)
  for (const list of byPlan.values()) {
    list.sort((a, b) => Date.parse(a.fetched_at) - Date.parse(b.fetched_at) || a.id - b.id)
  }
  return points.flatMap((point) => {
    const at = Date.parse(point.fetchedAt)
    let remaining = Number(point.totalRemainingPercent)
    let capacity = Number(point.totalCapacityPercent)
    let effective = point.effectiveRemainingPercent == null ? null : Number(point.effectiveRemainingPercent)
    let count = point.accountCount
    for (const plan of plans) {
      const list = byPlan.get(plan.id) ?? []
      let last: PlanReading | undefined
      for (const reading of list) {
        if (Date.parse(reading.fetched_at) > at) break
        last = reading
      }
      const share = weight(provider, plan, last)
      const weekly = room(last, WEEK_MINS, at) ?? 0
      remaining -= share * weekly
      capacity -= share * 100
      if (effective != null) effective -= share * (room(last, SESSION_MINS, at) === 0 ? 0 : weekly)
      count -= 1
    }
    if (count <= 0) return []
    return [{
      ...point,
      accountCount: count,
      totalCapacityPercent: round(capacity),
      totalRemainingPercent: round(remaining),
      effectiveRemainingPercent: effective == null ? effective : round(effective),
    }]
  })
}
