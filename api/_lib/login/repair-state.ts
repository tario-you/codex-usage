/**
 * Expired sign-ins are repaired from the dashboard: the sync agent on the
 * machine that holds the accounts reports which logins refresh with a 401,
 * the owner clicks Fix sign-ins, the agent picks up the request on its next
 * poll and opens one browser sign-in per account, then reports back. All of
 * that state lives in the device row's metadata under `repair`. The agent
 * also reports `missing`: accounts the machine has used and never saved (found
 * by `login setup`'s discovery), so the same button offers their sign-in.
 */
export interface RepairPending {
  provider?: 'claude'
  emails: string[]
  requestedAt: string
}

export interface RepairResult {
  provider?: 'claude'
  detail?: string | null
  email: string
  outcome: 'signed-in' | 'mismatch' | 'failed' | 'skipped'
}

/** The OpenAI sign-in the agent opened for a pending email, so the dashboard can show it. */
export interface RepairLink {
  provider?: 'claude'
  at: string
  email: string
  url: string
}

export interface RepairState {
  providers: ('codex' | 'claude')[]
  expired: string[]
  link: RepairLink | null
  missing: string[]
  lastResult: { at: string; results: RepairResult[] } | null
  pending: RepairPending | null
  reportedAt: string | null
}

export const REPAIR_PENDING_MAX_AGE_MS = 30 * 60 * 1000
/** Codex sign-in links stop working ten minutes after they are issued. */
export const REPAIR_LINK_MAX_AGE_MS = 10 * 60 * 1000

/** Only a Codex sign-in on OpenAI's own host is ever shown as a link to click. */
export function isSignInUrl(value: unknown, provider: 'codex' | 'claude' = 'codex'): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (provider === 'claude' ? ['claude.ai', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname) : url.hostname === 'auth.openai.com')
  } catch {
    return false
  }
}

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
          ...(entry.provider === 'claude' ? { provider: 'claude' as const } : {}),
          detail: typeof entry.detail === 'string' ? entry.detail : null,
          email: String(entry.email).toLowerCase(),
          outcome: entry.outcome as RepairResult['outcome'],
        }))
    : []
  const expired = normalizeEmails(repair.expired)
  const linkRaw = asObject(repair.link)
  const [linkEmail] = normalizeEmails([linkRaw.email])
  const linkAt = typeof linkRaw.at === 'string' ? linkRaw.at : null
  const linkFresh =
    linkEmail !== undefined &&
    isSignInUrl(linkRaw.url, linkRaw.provider === 'claude' ? 'claude' : 'codex') &&
    linkAt !== null &&
    Number.isFinite(Date.parse(linkAt)) &&
    now - Date.parse(linkAt) <= REPAIR_LINK_MAX_AGE_MS
  return {
    providers: Array.isArray(repair.providers) && repair.providers.includes('claude') ? ['codex', 'claude'] : ['codex'],
    expired,
    link: linkFresh ? { ...(linkRaw.provider === 'claude' ? { provider: 'claude' as const } : {}), at: linkAt as string, email: linkEmail, url: linkRaw.url as string } : null,
    missing: normalizeEmails(repair.missing).filter((email) => !expired.includes(email)),
    lastResult:
      typeof lastRaw.at === 'string' && results.length > 0 ? { at: lastRaw.at, results } : null,
    pending: pendingFresh ? { ...(pendingRaw.provider === 'claude' ? { provider: 'claude' as const } : {}), emails: pendingEmails, requestedAt: requestedAt as string } : null,
    reportedAt: typeof repair.reportedAt === 'string' ? repair.reportedAt : null,
  }
}

function writeRepair(metadata: unknown, patch: Record<string, unknown>) {
  const base = asObject(metadata)
  const repair = asObject(base.repair)
  return { ...base, repair: { ...repair, ...patch } }
}

/** The agent's report: saved logins that refuse to refresh, and accounts used here but never saved. */
export function withExpiredReport(metadata: unknown, expired: unknown, at: string, missing: unknown = [], providers: ('codex' | 'claude')[] = ['codex']) {
  return writeRepair(metadata, { expired: normalizeEmails(expired), missing: normalizeEmails(missing), reportedAt: at, providers })
}

/** Every email a sign-in would fix on this machine: expired first, then never saved. */
export function needsSignIn(state: RepairState) {
  return [...state.expired, ...state.missing.filter((email) => !state.expired.includes(email))]
}

/** The owner's request: only emails the agent itself reported as expired or missing qualify. */
export function withPendingRequest(metadata: unknown, emails: unknown, at: string) {
  const state = readRepairState(metadata)
  const eligible = needsSignIn(state)
  const wanted = normalizeEmails(emails)
  const targets = (wanted.length > 0 ? wanted : eligible).filter((email) => eligible.includes(email))
  if (targets.length === 0) return { metadata: asObject(metadata), targets }
  return {
    metadata: writeRepair(metadata, { pending: { emails: targets, requestedAt: at } }),
    targets,
  }
}

/**
 * The owner typed an email on the dashboard: the machine signs that account
 * in even though it never reported it, so a brand-new plan can be connected
 * from the website. It joins any request still fresh on that machine.
 */
export function withConnectRequest(metadata: unknown, email: unknown, at: string, provider: 'codex' | 'claude' = 'codex') {
  const [target] = normalizeEmails([email])
  if (!target) return { metadata: asObject(metadata), targets: [] as string[] }
  const state = readRepairState(metadata, Date.parse(at))
  if (state.pending && (state.pending.provider ?? 'codex') !== provider) return { metadata: asObject(metadata), targets: [] as string[] }
  const targets = [...(state.pending?.emails ?? []).filter((e) => e !== target), target]
  return {
    metadata: writeRepair(metadata, { link: null, pending: { ...(provider === 'claude' ? { provider } : {}), emails: targets, requestedAt: at } }),
    targets,
  }
}

/**
 * The agent opened a sign-in for one pending email and reports its URL, so
 * the dashboard can show a link to open or copy instead of hunting for the
 * tab. Anything but an OpenAI sign-in URL is dropped.
 */
export function withSignInLink(metadata: unknown, email: unknown, url: unknown, at: string, provider: 'codex' | 'claude' = 'codex') {
  const [target] = normalizeEmails([email])
  if (!target || !isSignInUrl(url, provider)) return { metadata: asObject(metadata), link: null }
  const link: RepairLink = { ...(provider === 'claude' ? { provider } : {}), at, email: target, url }
  return { metadata: writeRepair(metadata, { link }), link }
}

/** The agent's report after running the sign-ins; clears the request and its link. */
export function withResult(metadata: unknown, results: RepairResult[], at: string) {
  const state = readRepairState(metadata)
  const signedIn = new Set(results.filter((r) => r.outcome === 'signed-in' && r.provider !== 'claude').map((r) => r.email))
  return writeRepair(metadata, {
    expired: state.expired.filter((email) => !signedIn.has(email)),
    lastResult: { at, results },
    link: null,
    missing: state.missing.filter((email) => !signedIn.has(email)),
    pending: null,
  })
}

export function supportedRepairPending(state: RepairState, providers: string[] = ['codex']) {
  return state.pending && providers.includes(state.pending.provider ?? 'codex') ? state.pending : null
}
