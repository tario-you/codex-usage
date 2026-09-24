/**
 * Rate limit reset credits, spent where they save the most. Each Codex plan
 * earns its own "Full reset" credits and a credit only resets the plan that
 * owns it, so a reset is worth that plan's size times how long it would
 * otherwise have waited for its own reset: a Pro that comes back by itself in
 * two days gains two days, one stuck for six more days gains six. A Pro Lite
 * holds a quarter of a Pro (as in the usage forecast), so among equal plans
 * the one whose own reset is furthest away is reset first.
 *
 * A plan marked cancelled (Switchboard's `subscription_cancelled`) ends at
 * its `subscription_expires_at`. When it ends before its own reset would bring
 * it back, this is its credit's last chance, so it goes before every other
 * plan. The Moonshot auto-switch uses the same rule (moonshot-mobile #13080).
 *
 * This module has no Node imports: the CLI spends with it and the dashboard
 * shows its choice.
 */
export const RESET_CONSUME_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume'
/** After a spend, no second spend until the next passes have seen the reset land. */
export const RESET_SPEND_COOLDOWN_MS = 15 * 60 * 1000

/** One Pro Lite holds a quarter of a Pro's capacity. */
export function planWeight(planType) {
  return String(planType ?? '').trim().toLowerCase() === 'prolite' ? 0.25 : 1
}

/**
 * The plan whose credit to spend, or null. Each plan is
 * `{ id, exhausted, returnsAt, planType, credits, cancelled, endsAt }` with
 * times in milliseconds; `credits` counts the credits usable now.
 */
export function resetCreditTarget(plans, { now = Date.now() } = {}) {
  let best = null
  for (const plan of plans) {
    if (!plan.exhausted || !(plan.credits > 0)) continue
    const returnsAt = Number.isFinite(plan.returnsAt) ? plan.returnsAt : null
    const endsAt = plan.cancelled && Number.isFinite(plan.endsAt) ? plan.endsAt : null
    const lastChance = returnsAt != null && endsAt != null && endsAt > now && endsAt <= returnsAt
    const until = lastChance ? endsAt : returnsAt
    const savedMs = until == null ? 0 : Math.max(0, until - now)
    const score = planWeight(plan.planType) * savedMs
    if (!best || (lastChance && !best.lastChance) || (lastChance === best.lastChance && score > best.score)) {
      best = { lastChance, plan, savedMs, score }
    }
  }
  return best
}

/**
 * Whether to spend now: only once every plan read this pass is out, on the
 * plan resetCreditTarget picks.
 */
export function planResetSpend(plans, { now = Date.now() } = {}) {
  if (plans.length === 0) return { action: 'wait', reason: 'no-plans' }
  const open = plans.find((plan) => !plan.exhausted)
  if (open) return { action: 'wait', reason: 'usage-left', plan: open }
  const target = resetCreditTarget(plans, { now })
  if (!target) return { action: 'wait', reason: 'no-credits' }
  return { action: 'spend', ...target }
}

/** A plan's state from its raw usage endpoint response and its saved store entry. */
export function resetPlanFromUsage(id, data, account = null) {
  const rate = data?.rate_limit
  const windows = [rate?.primary_window, rate?.secondary_window].filter((window) => window && typeof window.used_percent === 'number')
  const exhausted = rate?.allowed === false || rate?.limit_reached === true || windows.some((window) => window.used_percent >= 100)
  const full = windows.filter((window) => window.used_percent >= 100)
  const blocking = (full.length > 0 ? full : windows).map((window) => window.reset_at).filter(Number.isFinite)
  const resets = data?.rate_limit_reset_credits
  const applicable = typeof resets?.applicable_available_count === 'number' ? resets.applicable_available_count : null
  const endsAt = Date.parse(account?.subscription_expires_at ?? '')
  return {
    cancelled: account?.subscription_cancelled === true,
    credits: applicable ?? (Number(resets?.available_count ?? 0) || 0),
    endsAt: Number.isFinite(endsAt) ? endsAt : null,
    exhausted,
    id,
    planType: typeof data?.plan_type === 'string' ? data.plan_type : (account?.plan_type ?? null),
    returnsAt: exhausted && blocking.length > 0 ? Math.max(...blocking) * 1000 : null,
  }
}

const OUTCOMES = new Map([
  ['reset', 'reset'],
  ['nothing_to_reset', 'nothingToReset'],
  ['no_credit', 'noCredit'],
  ['already_redeemed', 'alreadyRedeemed'],
])

/**
 * Spend one reset credit on the plan these tokens belong to: the request the
 * Codex app sends for account/rateLimitResetCredit/consume. The backend picks
 * which of the plan's credits to use.
 */
export async function consumeResetCredit(tokens, { fetcher = fetch, redeemRequestId = globalThis.crypto.randomUUID() } = {}) {
  const response = await fetcher(RESET_CONSUME_URL, {
    body: JSON.stringify({ redeem_request_id: redeemRequestId }),
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'ChatGPT-Account-Id': tokens.account_id,
      'Content-Type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) return { error: `reset request failed (HTTP ${response.status})`, outcome: null }
  const outcome = OUTCOMES.get(payload?.code) ?? null
  return outcome ? { outcome } : { error: `unexpected reset answer ${JSON.stringify(payload?.code ?? null)}`, outcome: null }
}

/** "2d 18h" or "3h 5m". */
export function formatWait(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes % 60}m`
}
