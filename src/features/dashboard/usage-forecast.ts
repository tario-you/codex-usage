import { planEndsAt, type PlanEndSource } from './plan-end'
import { weeklyPlanCapacity } from './usage-plan-capacity'
import { getRateLimitWindows } from '../../shared/rate-limit-windows'
import {
  projectRunOut,
  type NextWeeklyResetSource,
  type UsageProjection,
  type UsageProjectionInputPoint,
} from './usage-projection'

const HOUR = 60 * 60 * 1000
export const FORECAST_HORIZON_MS = 7 * 24 * HOUR

/** Weekly pool estimate, consuming the balance that expires first, like the plan order:
 * a balance expires at its weekly reset or at its plan's end, whichever is sooner.
 * At its end a plan's balance is gone and never refills.
 * Only reported future resets are used; rolling windows are not invented.
 * Session limits and sign-in availability are outside this weekly allowance chart.
 */
export function forecastWeeklyUsage(
  points: readonly UsageProjectionInputPoint[],
  accounts: readonly (NextWeeklyResetSource & PlanEndSource)[],
): UsageProjection | null {
  const pace = projectRunOut(points)
  if (!pace) return null
  const start = Date.parse(pace.fromAt)
  const end = start + FORECAST_HORIZON_MS
  const expiry = (item: { reset: number; ends: number }) => Math.min(item.reset, item.ends)
  const balances = accounts.flatMap((account) => {
    const window = getRateLimitWindows(account).find((item) => item.windowDurationMins === 10080)
    if (window?.remainingPercent == null) return []
    const reset = Date.parse(window.resetsAt ?? '')
    // A plan that already ended still loses its balance, at the start.
    const ends = Math.max(start, planEndsAt(account) ?? Infinity)
    const capacity = weeklyPlanCapacity(account)
    return [{
      capacity,
      remaining: window.remainingPercent * capacity / 100,
      reset: Number.isFinite(reset) && reset > start && reset < ends ? reset : Infinity,
      ends,
      label: `${account.label ?? 'a plan'}${account.account_key?.startsWith('claude:') ? ' (Claude)' : ''}`,
    }]
  }).sort((a, b) => expiry(a) - expiry(b))

  // Account snapshots and history can arrive separately. Preserve the plotted
  // starting total; unattributed allowance has no assumed reset.
  const total = balances.reduce((sum, item) => sum + item.remaining, 0)
  const remaining = Math.max(0, pace.fromRemainingPercent)
  if (total > remaining) {
    for (const item of balances) item.remaining *= remaining / total
  }
  balances.push({ capacity: 0, remaining: Math.max(0, remaining - total), reset: Infinity, ends: Infinity, label: '' })
  const sum = () => balances.reduce((value, item) => value + item.remaining, 0)
  const timeline: NonNullable<UsageProjection['timeline']> = []
  const resets: NonNullable<UsageProjection['resets']> = []
  const push = (at: number) => timeline.push({ at: new Date(at).toISOString(), remainingPercent: sum() })
  let cursor = start
  let runsOutAt: string | null = remaining === 0 ? pace.fromAt : null
  // Use the unrounded pace so the plotted line and first depletion agree.
  const rate = pace.paceSpanMs > 0 ? pace.spentPercent / pace.paceSpanMs : 0
  const spendUntil = (at: number) => {
    const available = sum()
    const demand = (at - cursor) * rate
    if (rate > 0 && demand > available) {
      const emptyAt = cursor + available / rate
      runsOutAt ??= new Date(emptyAt).toISOString()
      let spend = available
      for (const item of balances) {
        const used = Math.min(item.remaining, spend)
        item.remaining -= used
        spend -= used
      }
      push(emptyAt)
    } else {
      let spend = demand
      for (const item of balances) {
        const used = Math.min(item.remaining, spend)
        item.remaining -= used
        spend -= used
      }
    }
    cursor = at
    push(at)
  }
  push(start)
  const times = [...new Set(balances.flatMap((item) => [item.reset, item.ends]).filter((at) => at <= end))]
    .sort((a, b) => a - b)
  for (const at of times) {
    spendUntil(at)
    for (const item of balances.filter((item) => item.ends === at)) {
      // The plan ended: what it had left is lost, and it never refills.
      item.remaining = 0
      item.capacity = 0
      item.reset = Infinity
    }
    for (const item of balances.filter((item) => item.reset === at)) {
      const addedPercent = item.capacity - item.remaining
      item.remaining = item.capacity
      resets.push({ at: new Date(at).toISOString(), addedPercent, label: item.label })
      // After its reported reset, this account goes behind remaining known resets.
      item.reset = Infinity
    }
    balances.sort((a, b) => expiry(a) - expiry(b))
    push(at)
  }
  spendUntil(end)
  if (sum() === 0) runsOutAt ??= new Date(end).toISOString()
  return { ...pace, runsOutAt, timeline, resets, endAt: new Date(end).toISOString() }
}
