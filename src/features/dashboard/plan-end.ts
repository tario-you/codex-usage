/**
 * A plan's end date: the moment the owner says the plan stops working
 * (`codex_accounts.plan_ends_at`). Room left on a plan is lost then, so the
 * plan order, the forecast and the shared-login pool all read it from here.
 * Pure: no clock is read, so tests pin it.
 */
export interface PlanEndSource {
  plan_ends_at?: string | null
}

/** The end as epoch ms, or null when the owner never set one. */
export function planEndsAt(account: PlanEndSource): number | null {
  const at = account.plan_ends_at ? Date.parse(account.plan_ends_at) : Number.NaN
  return Number.isFinite(at) ? at : null
}

export function hasPlanEnded(account: PlanEndSource, now: number) {
  const endsAt = planEndsAt(account)
  return endsAt != null && endsAt <= now
}

/** A plan's end is entered as a calendar day; it ends when that day starts, in the browser's own time zone. */
export function planEndFromDateInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const [, year, month, day] = match.map(Number)
  const at = new Date(year, month - 1, day)
  return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day ? at.toISOString() : null
}

/** The calendar day a stored end falls on, in the browser's time zone, as a date input value. */
export function planEndToDateInput(value: string | null | undefined): string {
  const at = value ? new Date(value) : null
  if (!at || !Number.isFinite(at.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

export function formatPlanEnd(endsAt: number, now: number) {
  const day = new Date(endsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return endsAt <= now ? `ended ${day}` : `ends ${day}`
}

/** The first monthly anniversary of `anchor` after `now`; a day the month lacks falls on its last day, as billing does. */
export function renewalAfter(anchor: number, now: number): number {
  const start = new Date(anchor)
  for (let months = 0; months < 1200; months += 1) {
    const year = start.getUTCFullYear() + Math.floor((start.getUTCMonth() + months) / 12)
    const month = (start.getUTCMonth() + months) % 12
    const day = Math.min(start.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
    const at = Date.UTC(year, month, day, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds())
    if (at > now) return at
  }
  return anchor
}

export interface PlanRenewalSource {
  metadata?: unknown
  raw_rate_limits?: unknown
}

/**
 * When a paid plan with no typed end next renews: a Claude plan's start (Anthropic's subscription_created_at, kept as
 * metadata.subscription_started_at) or a Codex plan's billing date (the switcher's subscription.endsAt, which stays at
 * the period it was read in), each rolled forward a month at a time. Null for a cancelled plan, which ends instead.
 */
export function planRenewsAt(account: PlanRenewalSource, now: number): number | null {
  const started = (account.metadata as { subscription_started_at?: unknown } | null | undefined)?.subscription_started_at
  const startedAt = typeof started === 'string' ? Date.parse(started) : Number.NaN
  if (Number.isFinite(startedAt)) return renewalAfter(startedAt, now)
  const subscription = (account.raw_rate_limits as { subscription?: { cancelled?: unknown; endsAt?: unknown } } | null | undefined)?.subscription
  if (subscription?.cancelled === true || typeof subscription?.endsAt !== 'number') return null
  return renewalAfter(subscription.endsAt * 1000, now)
}
