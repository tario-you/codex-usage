import {
  resetCreditTarget,
  type ResetCreditTarget,
  type ResetPlanState,
} from '../../../bin/lib/reset-credits.js'
import { isClaudeAccountKey } from '../../shared/codex.js'

export interface ResetCreditChoiceRow {
  account_key: string | null
  email: string | null
  id: string | null
  label: string | null
  plan_type: string | null
  primary_resets_at: string | null
  primary_used_percent: number | null
  raw_rate_limits: unknown
  secondary_resets_at: string | null
  secondary_used_percent: number | null
}

export interface ResetCreditChoice extends ResetCreditTarget {
  accountLabel: string
}

/**
 * The plan whose reset credit the agent would spend next (the same rule as
 * `sync --all --spend-resets`), read from the dashboard rows. A window whose
 * reset time has passed counts as reset.
 */
export function resetCreditChoice(rows: ResetCreditChoiceRow[], now = Date.now()): ResetCreditChoice | null {
  const plans: ResetPlanState[] = []
  const labels = new Map<string, string>()
  for (const row of rows) {
    if (!row.id || isClaudeAccountKey(row.account_key)) continue
    const plan = planFromRow(row, now)
    plans.push(plan)
    labels.set(row.id, row.label ?? row.email ?? row.account_key ?? row.id)
  }
  const target = resetCreditTarget(plans, { now })
  return target ? { ...target, accountLabel: labels.get(target.plan.id) ?? target.plan.id } : null
}

function planFromRow(row: ResetCreditChoiceRow, now: number): ResetPlanState {
  const raw = (row.raw_rate_limits ?? {}) as {
    resetCredits?: { applicable?: number | null; available?: number }
    subscription?: { cancelled?: boolean; endsAt?: number | null }
  }
  const blocking = [
    [row.primary_used_percent, row.primary_resets_at],
    [row.secondary_used_percent, row.secondary_resets_at],
  ]
    .filter(([used]) => typeof used === 'number' && used >= 100)
    .map(([, resetsAt]) => (typeof resetsAt === 'string' ? Date.parse(resetsAt) : Number.NaN))
    .filter((resetsAt) => !(resetsAt <= now))
  const known = blocking.filter(Number.isFinite)
  const endsAt = raw.subscription?.endsAt
  return {
    cancelled: raw.subscription?.cancelled === true,
    credits: raw.resetCredits?.applicable ?? raw.resetCredits?.available ?? 0,
    endsAt: typeof endsAt === 'number' ? endsAt * 1000 : null,
    exhausted: blocking.length > 0,
    id: row.id as string,
    planType: row.plan_type,
    returnsAt: blocking.length > 0 && known.length === blocking.length ? Math.max(...known) : null,
  }
}

/** A cancelled plan's end, or null. */
export function subscriptionEnd(rawRateLimits: unknown): number | null {
  const subscription = (rawRateLimits as { subscription?: { cancelled?: boolean; endsAt?: number | null } } | null)?.subscription
  return subscription?.cancelled === true && typeof subscription.endsAt === 'number' ? subscription.endsAt * 1000 : null
}
