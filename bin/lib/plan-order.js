/** Canonical dashboard and auto-switch ordering. All timestamps are epoch ms.
 * The switcher vendors these exact bytes, with a pinned SHA-256.
 */
export function planEligible(planType) {
  const plan = String(planType ?? '').trim().toLowerCase()
  return plan ? !['free', 'free_workspace'].includes(plan) : null
}

export function planWeight(planType) {
  return String(planType ?? '').trim().toLowerCase() === 'prolite' ? 0.25 : 1
}

export function isUsablePlan(plan, now = Date.now()) {
  if (plan.cancelled === true || plan.accessLost === true) return false
  if (plan.connectionStatus != null && plan.connectionStatus !== 'connected') return false
  if (finite(plan.endsAt) != null && plan.endsAt <= now) return false
  if (finite(plan.endsAt) != null && plan.exhausted && !(plan.credits > 0) && (plan.returnsAt == null || plan.returnsAt >= plan.endsAt)) return false
  // Old balances cannot establish usable access. A newer healthy check can.
  const checkedAt = finite(plan.checkedAt)
  return checkedAt == null || now - checkedAt <= 12 * 60 * 60 * 1000
}

export function resetPriority(plan, now) {
  const returnsAt = finite(plan.returnsAt)
  const endsAt = finite(plan.endsAt)
  const lastChance = returnsAt != null && endsAt != null && endsAt > now && endsAt <= returnsAt
  const until = lastChance ? endsAt : returnsAt
  const savedMs = until == null ? 0 : Math.max(0, until - now)
  return { lastChance, savedMs, score: planWeight(plan.planType) * savedMs }
}

export function useGroup(plan, now) {
  if (planEligible(plan.planType) === false) return 6
  if (finite(plan.endsAt) != null && plan.endsAt <= now) return 5
  if (plan.available === true) return 0
  if (planEligible(plan.planType) === true && plan.exhausted === true && plan.credits > 0) return 1
  if (finite(plan.endsAt) != null && plan.exhausted && (plan.returnsAt == null || plan.returnsAt >= plan.endsAt)) return 5
  if (!plan.exhausted) return 3
  return plan.weeklySpent ? 4 : 2
}

export function comparePlansForUse(left, right, now) {
  const group = useGroup(left, now), other = useGroup(right, now)
  const leading = group - other || (left.provider ?? 0) - (right.provider ?? 0)
  if (leading) return leading
  if (group === 1) {
    const a = resetPriority(left, now), b = resetPriority(right, now)
    return Number(b.lastChance) - Number(a.lastChance) || b.score - a.score
  }
  if (left.available && right.available) {
    return compareTimes(left.expiresAt, right.expiresAt) || compareTimes(left.endsAt, right.endsAt)
      || (right.usablePercent ?? 0) - (left.usablePercent ?? 0)
      || String(left.label ?? '').localeCompare(String(right.label ?? ''))
  }
  return compareTimes(left.returnsAt, right.returnsAt)
}

export function orderPlansForUse(plans, { now = Date.now() } = {}) {
  return plans.filter(plan => isUsablePlan(plan, now)).map((plan, index) => ({ plan, index }))
    .sort((a, b) => comparePlansForUse(a.plan, b.plan, now) || a.index - b.index)
    .map(({ plan }) => plan)
}

function finite(value) { return Number.isFinite(value) ? value : null }
function compareTimes(left, right) {
  const a = finite(left), b = finite(right)
  return a === b ? 0 : a == null ? 1 : b == null ? -1 : a - b
}
