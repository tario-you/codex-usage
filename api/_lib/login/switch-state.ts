/**
 * One-click plan switching. The owner clicks "Use" on a Plans row; the
 * request lands in the device row's metadata under `planSwitch`; the sync
 * agent on that machine picks it up on its next poll, asks the local Codex
 * Switchboard to make that login the active one, and reports the outcome.
 * The agent also reports which login is active on every poll, so the
 * dashboard can mark the active row and offer "Use" on the others.
 */
export interface PlanSwitchPending {
  email: string
  requestId: string
  requestedAt: string
}

export interface PlanSwitchResult {
  at: string
  detail: string | null
  email: string
  outcome: 'switched' | 'failed'
  requestId: string | null
}

export interface PlanSwitchActive {
  email: string
  reportedAt: string
}

export interface PlanSwitchState {
  active: PlanSwitchActive | null
  lastResult: PlanSwitchResult | null
  pending: PlanSwitchPending | null
}

/** A click nobody picked up within this window is dropped, never replayed hours later. */
export const PLAN_SWITCH_PENDING_MAX_AGE_MS = 3 * 60 * 1000
/** Outcomes older than this are history, not something the row still shows. */
export const PLAN_SWITCH_RESULT_MAX_AGE_MS = 10 * 60 * 1000

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.includes('@') && email.length <= 320 ? email : null
}

function freshIso(value: unknown, maxAgeMs: number, now: number): string | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return null
  return now - at <= maxAgeMs ? value : null
}

export function readPlanSwitchState(metadata: unknown, now = Date.now()): PlanSwitchState {
  const state = asObject(asObject(metadata).planSwitch)

  const pendingRaw = asObject(state.pending)
  const pendingEmail = normalizeEmail(pendingRaw.email)
  const requestedAt = freshIso(pendingRaw.requestedAt, PLAN_SWITCH_PENDING_MAX_AGE_MS, now)
  const requestId = typeof pendingRaw.requestId === 'string' ? pendingRaw.requestId : null
  const pending =
    pendingEmail && requestedAt && requestId ? { email: pendingEmail, requestId, requestedAt } : null

  const activeRaw = asObject(state.active)
  const activeEmail = normalizeEmail(activeRaw.email)
  const active =
    activeEmail && typeof activeRaw.reportedAt === 'string'
      ? { email: activeEmail, reportedAt: activeRaw.reportedAt }
      : null

  const resultRaw = asObject(state.lastResult)
  const resultEmail = normalizeEmail(resultRaw.email)
  const resultAt = freshIso(resultRaw.at, PLAN_SWITCH_RESULT_MAX_AGE_MS, now)
  const lastResult =
    resultEmail && resultAt && (resultRaw.outcome === 'switched' || resultRaw.outcome === 'failed')
      ? {
          at: resultAt,
          detail: typeof resultRaw.detail === 'string' ? resultRaw.detail : null,
          email: resultEmail,
          outcome: resultRaw.outcome as PlanSwitchResult['outcome'],
          requestId: typeof resultRaw.requestId === 'string' ? resultRaw.requestId : null,
        }
      : null

  return { active, lastResult, pending }
}

function writePlanSwitch(metadata: unknown, patch: Record<string, unknown>) {
  const base = asObject(metadata)
  return { ...base, planSwitch: { ...asObject(base.planSwitch), ...patch } }
}

/**
 * The owner's click. One request at a time per machine: a fresh pending
 * request for another login is refused rather than silently replaced, since
 * the agent may already be halfway through it.
 */
export function withSwitchRequest(metadata: unknown, email: unknown, requestId: string, at: string) {
  const target = normalizeEmail(email)
  if (!target) return { metadata: asObject(metadata), pending: null, reason: 'invalid-email' as const }
  const state = readPlanSwitchState(metadata, Date.parse(at))
  if (state.pending && state.pending.email !== target) {
    return { metadata: asObject(metadata), pending: state.pending, reason: 'busy' as const }
  }
  if (state.active?.email === target && !state.pending) {
    return { metadata: asObject(metadata), pending: null, reason: 'already-active' as const }
  }
  if (state.pending) return { metadata: asObject(metadata), pending: state.pending, reason: 'duplicate' as const }
  const pending: PlanSwitchPending = { email: target, requestId, requestedAt: at }
  return { metadata: writePlanSwitch(metadata, { pending }), pending, reason: null }
}

/** The agent's poll: which login the machine is signed into right now. */
export function withActiveReport(metadata: unknown, email: unknown, at: string) {
  const active = normalizeEmail(email)
  return writePlanSwitch(metadata, { active: active ? { email: active, reportedAt: at } : null })
}

/**
 * The agent's outcome. A success also becomes the active login right away,
 * so the row flips without waiting for the next poll. A stale request id is
 * still recorded (the click already expired) but never clears a newer request.
 */
export function withSwitchResult(
  metadata: unknown,
  result: { detail?: string | null; email: unknown; outcome: 'switched' | 'failed'; requestId?: string | null },
  at: string,
) {
  const email = normalizeEmail(result.email)
  if (!email) return asObject(metadata)
  const state = readPlanSwitchState(metadata, Date.parse(at))
  const requestId = result.requestId ?? null
  const clears = !state.pending || !requestId || state.pending.requestId === requestId
  const patch: Record<string, unknown> = {
    lastResult: { at, detail: result.detail ?? null, email, outcome: result.outcome, requestId },
  }
  if (clears) patch.pending = null
  if (result.outcome === 'switched') patch.active = { email, reportedAt: at }
  return writePlanSwitch(metadata, patch)
}
