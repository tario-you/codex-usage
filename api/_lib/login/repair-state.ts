/**
 * Expired sign-ins are repaired from the dashboard: the sync agent on the
 * machine that holds the accounts reports which logins refresh with a 401,
 * the owner clicks Fix sign-ins, the agent picks up the request on its next
 * poll and opens one browser sign-in per account, then reports back. All of
 * that state lives in the device row's metadata under `repair`.
 */
export interface RepairPending {
  emails: string[]
  requestedAt: string
}

export interface RepairResult {
  detail?: string | null
  email: string
  outcome: 'signed-in' | 'mismatch' | 'failed' | 'skipped'
}

export interface RepairState {
  expired: string[]
  lastResult: { at: string; results: RepairResult[] } | null
  pending: RepairPending | null
  reportedAt: string | null
}

export const REPAIR_PENDING_MAX_AGE_MS = 30 * 60 * 1000

export function normalizeEmails(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  for (const value of list) {
    if (typeof value !== 'string') continue
    const email = value.trim().toLowerCase()
    if (email.includes('@') && email.length <= 320) seen.add(email)
  }
  return [...seen]
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function readRepairState(metadata: unknown, now = Date.now()): RepairState {
  const repair = asObject(asObject(metadata).repair)
  const pendingRaw = asObject(repair.pending)
  const pendingEmails = normalizeEmails(pendingRaw.emails)
  const requestedAt = typeof pendingRaw.requestedAt === 'string' ? pendingRaw.requestedAt : null
  const pendingFresh =
    pendingEmails.length > 0 &&
    requestedAt !== null &&
    Number.isFinite(Date.parse(requestedAt)) &&
    now - Date.parse(requestedAt) <= REPAIR_PENDING_MAX_AGE_MS
  const lastRaw = asObject(repair.lastResult)
  const results = Array.isArray(lastRaw.results)
    ? (lastRaw.results as unknown[])
        .map((entry) => asObject(entry))
        .filter((entry) => typeof entry.email === 'string' && typeof entry.outcome === 'string')
        .map((entry) => ({
          detail: typeof entry.detail === 'string' ? entry.detail : null,
          email: String(entry.email).toLowerCase(),
          outcome: entry.outcome as RepairResult['outcome'],
        }))
    : []
  return {
    expired: normalizeEmails(repair.expired),
    lastResult:
      typeof lastRaw.at === 'string' && results.length > 0 ? { at: lastRaw.at, results } : null,
    pending: pendingFresh ? { emails: pendingEmails, requestedAt: requestedAt as string } : null,
    reportedAt: typeof repair.reportedAt === 'string' ? repair.reportedAt : null,
  }
}

function writeRepair(metadata: unknown, patch: Record<string, unknown>) {
  const base = asObject(metadata)
  const repair = asObject(base.repair)
  return { ...base, repair: { ...repair, ...patch } }
}

/** The agent's report of which saved logins refuse to refresh. */
export function withExpiredReport(metadata: unknown, expired: unknown, at: string) {
  return writeRepair(metadata, { expired: normalizeEmails(expired), reportedAt: at })
}

/** The owner's request: only emails the agent itself reported as expired qualify. */
export function withPendingRequest(metadata: unknown, emails: unknown, at: string) {
  const state = readRepairState(metadata)
  const wanted = normalizeEmails(emails)
  const targets = (wanted.length > 0 ? wanted : state.expired).filter((email) =>
    state.expired.includes(email),
  )
  if (targets.length === 0) return { metadata: asObject(metadata), targets }
  return {
    metadata: writeRepair(metadata, { pending: { emails: targets, requestedAt: at } }),
    targets,
  }
}

/** The agent's report after running the sign-ins; clears the request. */
export function withResult(metadata: unknown, results: RepairResult[], at: string) {
  const state = readRepairState(metadata)
  const signedIn = new Set(results.filter((r) => r.outcome === 'signed-in').map((r) => r.email))
  return writeRepair(metadata, {
    expired: state.expired.filter((email) => !signedIn.has(email)),
    lastResult: { at, results },
    pending: null,
  })
}
