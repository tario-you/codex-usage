import { DASHBOARD_UPLOAD_TIMEOUT_MS, dashboardRequest } from './dashboard-request.js'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import {
  decodeJwtPayload,
  readJsonFile,
  resolveDefaultSwitcherStorePath,
  validateSharedLoginFile,
  writeJsonFilePrivately,
} from './login-file.js'
import { consumeResetCredit, planResetSpend, resetPlanFromUsage } from './reset-credits.js'

/**
 * One machine, every account. `login add` saves each Codex login once into the
 * same store the Codex Switchboard keeps (`~/.codex-switcher/accounts.json`,
 * mode 600), and `sync --all` reports every saved login to the dashboard
 * without touching the Codex app: it reads each account's usage straight from
 * the ChatGPT usage endpoint, refreshing an expired token on the way.
 */
export const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const DEFAULT_SYNC_ALL_INTERVAL_SECONDS = 300
export const MIN_SYNC_ALL_INTERVAL_SECONDS = 60

export function resolveStorePath(option) {
  if (!option) return resolveDefaultSwitcherStorePath()
  const expanded = option.startsWith('~/') ? path.join(os.homedir(), option.slice(2)) : option
  return path.resolve(expanded)
}

export async function readStore(storePath) {
  if (!existsSync(storePath)) return { version: 1, accounts: [], masked_account_ids: [] }
  const store = await readJsonFile(storePath)
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error(`Unreadable account store at ${storePath}.`)
  }
  if (!Array.isArray(store.accounts)) store.accounts = []
  return store
}

export async function writeStore(storePath, store) {
  await writeJsonFilePrivately(storePath, store)
}

function loginIdentity(tokens) {
  if (tokens?.account_id) return `id:${tokens.account_id}`
  const email = decodeJwtPayload(tokens?.id_token ?? '')?.email
  return email ? `email:${email.toLowerCase()}` : null
}

/** Save a Codex auth file into the store; an account already there keeps its id. */
export function upsertStoreAccount(store, authFile, { now = new Date() } = {}) {
  validateSharedLoginFile(authFile)
  const tokens = authFile.tokens
  const claims = decodeJwtPayload(tokens.id_token) ?? {}
  const auth = claims['https://api.openai.com/auth'] ?? {}
  const email = typeof claims.email === 'string' ? claims.email : null
  const identity = loginIdentity(tokens)
  let account =
    store.accounts.find((entry) => loginIdentity(entry.auth_data) === identity) ??
    (email ? store.accounts.find((entry) => entry.email?.toLowerCase() === email.toLowerCase()) : null)
  const created = !account
  if (!account) {
    account = {
      id: randomUUID(),
      name: email ?? 'Codex account',
      email,
      plan_type: auth.chatgpt_plan_type ?? null,
      subscription_expires_at: auth.chatgpt_subscription_active_until ?? null,
      auth_mode: 'chat_g_p_t',
      created_at: now.toISOString(),
      last_used_at: null,
    }
    store.accounts.push(account)
  }
  account.auth_data = {
    type: 'chat_g_p_t',
    ...(account.auth_data ?? {}),
    account_id: tokens.account_id,
    id_token: tokens.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  }
  if (email && !account.email) account.email = email
  if (auth.chatgpt_plan_type) account.plan_type = auth.chatgpt_plan_type
  return { account, created }
}

export async function refreshTokens(tokens, fetcher = fetch) {
  const response = await fetcher(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CODEX_OAUTH_CLIENT_ID,
      refresh_token: tokens.refresh_token,
    }),
  })
  if (!response.ok) return null
  const next = await response.json()
  const refreshed = { ...tokens }
  for (const key of ['id_token', 'access_token', 'refresh_token']) {
    if (typeof next[key] === 'string' && next[key]) refreshed[key] = next[key]
  }
  return refreshed
}

/** Usage for one saved login. A 401 gets one token refresh, then one retry. */
export async function fetchUsage(tokens, fetcher = fetch) {
  const call = (current) =>
    fetcher(USAGE_URL, {
      headers: { Authorization: `Bearer ${current.access_token}`, 'ChatGPT-Account-Id': current.account_id },
      signal: AbortSignal.timeout(20_000),
    })
  let current = tokens
  let refreshed = false
  let response = await call(current)
  if (response.status === 401) {
    const next = await refreshTokens(current, fetcher)
    if (!next) return { error: 'sign-in expired; run `login add` for this account again' }
    current = next
    refreshed = true
    response = await call(current)
  }
  if (!response.ok) return { error: `usage request failed (HTTP ${response.status})` }
  return { data: await response.json(), tokens: current, refreshed }
}

function windowValue(window) {
  if (!window || typeof window.used_percent !== 'number') return null
  return {
    resetsAt: Number.isFinite(window.reset_at) ? window.reset_at : null,
    usedPercent: window.used_percent,
    windowDurationMins: Number.isFinite(window.limit_window_seconds)
      ? Math.round(window.limit_window_seconds / 60)
      : null,
  }
}

/** The dashboard's sync payload, built from the raw usage endpoint response and the login's store entry. */
export function buildSyncPayloadFromUsage(data, email = null, account = null) {
  const credits = {
    balance: String(data.credits?.balance ?? '0'),
    hasCredits: Boolean(data.credits?.has_credits),
    unlimited: Boolean(data.credits?.unlimited),
  }
  const planType = typeof data.plan_type === 'string' ? data.plan_type : null
  const snapshot = (rate, name, limitId) => ({
    credits,
    limitId,
    limitName: name,
    planType,
    primary: windowValue(rate?.primary_window),
    secondary: windowValue(rate?.secondary_window),
  })
  const main = snapshot(data.rate_limit, 'Codex', 'codex')
  const resets = data.rate_limit_reset_credits
  main.resetCredits = {
    applicable: typeof resets?.applicable_available_count === 'number' ? resets.applicable_available_count : null,
    available: Number(resets?.available_count ?? 0) || 0,
  }
  // Switchboard's cancelled flag and the subscription's end ride along, so the
  // dashboard shows the same reset choice the agent makes.
  const endsAt = Date.parse(account?.subscription_expires_at ?? '')
  if (account?.subscription_cancelled === true || Number.isFinite(endsAt)) {
    main.subscription = {
      cancelled: account?.subscription_cancelled === true,
      endsAt: Number.isFinite(endsAt) ? Math.round(endsAt / 1000) : null,
    }
  }
  const byLimitId = { codex: main }
  for (const extra of data.additional_rate_limits ?? []) {
    const id = extra?.metered_feature || extra?.limit_name
    if (id) byLimitId[id] = snapshot(extra.rate_limit, extra.limit_name ?? id, id)
  }
  const accountEmail = email ?? (typeof data.email === 'string' ? data.email : undefined)
  return {
    accountState: {
      account: {
        type: 'chatgpt',
        ...(accountEmail ? { email: accountEmail } : {}),
        ...(planType ? { planType } : {}),
      },
      requiresOpenaiAuth: false,
    },
    rateLimits: { rateLimits: main, rateLimitsByLimitId: byLimitId },
  }
}

/**
 * Report every saved login once. Refreshed tokens and a newly saved active
 * login are merged into the store as it is on disk at write time, so a
 * concurrent switch elsewhere keeps its own changes.
 */
export async function syncAllOnce({ config, storePath, device, fetcher = fetch, activeAuthFile = null, spendResets = false, resetHoldUntil = 0, now = Date.now() }) {
  const store = await readStore(storePath)
  const changedIds = new Set()
  const added = []
  if (activeAuthFile) {
    try {
      const { account, created } = upsertStoreAccount(store, activeAuthFile)
      if (created) added.push(account)
      changedIds.add(account.id)
    } catch {
      // A login this machine holds in another mode is not ours to save.
    }
  }
  const results = []
  const fresh = []
  for (const account of store.accounts) {
    const tokens = account.auth_data
    const label = account.email ?? account.id
    if (!tokens?.access_token || !tokens?.refresh_token || !tokens?.account_id) {
      results.push({ email: label, ok: false, reason: 'no saved login tokens' })
      continue
    }
    const usage = await fetchUsage(tokens, fetcher)
    if (usage.error) {
      results.push({ email: label, ok: false, reason: usage.error })
      continue
    }
    if (usage.refreshed) {
      account.auth_data = { ...account.auth_data, ...usage.tokens }
      changedIds.add(account.id)
    }
    fresh.push({ account, plan: resetPlanFromUsage(account.id, usage.data, account) })
    const payload = buildSyncPayloadFromUsage(usage.data, account.email, account)
    const response = await fetcher(
      config.syncUrl,
      dashboardRequest({ ...payload, device, deviceToken: config.deviceToken }, { timeoutMs: DASHBOARD_UPLOAD_TIMEOUT_MS }),
    )
    if (!response.ok) {
      results.push({ email: label, ok: false, reason: `dashboard rejected the sync (HTTP ${response.status})` })
      continue
    }
    results.push({
      email: label,
      ok: true,
      planType: usage.data.plan_type ?? null,
      usedPercent: usage.data.rate_limit?.primary_window?.used_percent ?? null,
    })
  }
  const resetSpend = spendResets
    ? await spendResetWherePays({ changedIds, config, device, fetcher, fresh, holdUntil: resetHoldUntil, now })
    : null
  if (changedIds.size > 0) {
    const latest = await readStore(storePath)
    for (const account of store.accounts) {
      if (!changedIds.has(account.id)) continue
      const target = latest.accounts.find((entry) => entry.id === account.id)
      if (target) target.auth_data = account.auth_data
      else latest.accounts.push(account)
    }
    await writeStore(storePath, latest)
  }
  return {
    added: added.map((account) => account.email ?? account.id),
    resetSpend,
    results,
    storePath,
    synced: results.filter((result) => result.ok).length,
    total: store.accounts.length,
  }
}

/**
 * `sync --all --spend-resets`: once every plan read this pass is out, spend
 * the reset credit that saves the most (reset-credits.js), then read and
 * report that plan again so the dashboard shows it back. One spend per
 * cooldown, so a slow usage endpoint can never lead to a second credit.
 */
async function spendResetWherePays({ changedIds, config, device, fetcher, fresh, holdUntil, now }) {
  const decision = planResetSpend(fresh.map((entry) => entry.plan), { now })
  if (decision.action !== 'spend') return { action: 'wait', reason: decision.reason }
  if (now < holdUntil) return { action: 'wait', reason: 'cooldown' }
  const entry = fresh.find((item) => item.plan.id === decision.plan.id)
  const email = entry.account.email ?? entry.account.id
  const spent = await consumeResetCredit(entry.account.auth_data, { fetcher })
  const result = {
    action: 'spent',
    email,
    error: spent.error ?? null,
    lastChance: decision.lastChance,
    outcome: spent.outcome,
    planType: decision.plan.planType,
    savedMs: decision.savedMs,
  }
  if (spent.outcome !== 'reset') return result
  const usage = await fetchUsage(entry.account.auth_data, fetcher)
  if (usage.error) return result
  if (usage.refreshed) {
    entry.account.auth_data = { ...entry.account.auth_data, ...usage.tokens }
    changedIds.add(entry.account.id)
  }
  result.usableAfter = !resetPlanFromUsage(entry.account.id, usage.data, entry.account).exhausted
  const payload = buildSyncPayloadFromUsage(usage.data, entry.account.email, entry.account)
  await fetcher(
    config.syncUrl,
    dashboardRequest({ ...payload, device, deviceToken: config.deviceToken }, { timeoutMs: DASHBOARD_UPLOAD_TIMEOUT_MS }),
  ).catch(() => null)
  return result
}

/**
 * One owner spends resets per machine. When the Moonshot auto-switch wraps
 * the Codex desktop here, it spends a credit the moment a chat stops, so this
 * agent stands down instead of racing it. An unreadable record stands down too.
 */
export function resetSpendingOwnedElsewhere({ home = os.homedir() } = {}) {
  const file = path.join(home, '.local/state/codex-auto-switch/installation.json')
  if (!existsSync(file)) return false
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))
    return record?.enabled === true && typeof record.bin === 'string' && existsSync(record.bin)
  } catch {
    return true
  }
}

/** Emails whose saved sign-in is dead: the only failures a fresh sign-in fixes. */
export function expiredEmailsFromResults(results) {
  return (results ?? [])
    .filter((result) => !result.ok && /sign-in expired/i.test(String(result.reason ?? '')))
    .map((result) => String(result.email ?? '').trim().toLowerCase())
    .filter((email) => email.includes('@'))
}

/**
 * The dashboard's repair endpoints answer with JSON that the CLI reads through
 * parseResponseBody, which wraps the body as { data, text }. Both readers take
 * that wrapper (or a bare body) so a wrapper change can never silence the
 * owner's request again: until 0.4.1 the poll read `payload.pending` off the
 * wrapper and always saw nothing.
 */
function bodyOf(payload) {
  if (!payload || typeof payload !== 'object') return {}
  const inner = payload.data
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : payload
}

/** The pending sign-in request from /api/login/repair/poll, or null. */
export function pendingFromPoll(payload) {
  const pending = bodyOf(payload).pending
  if (!pending || typeof pending !== 'object') return null
  const emails = Array.isArray(pending.emails) ? pending.emails.filter((e) => typeof e === 'string' && e.includes('@')) : []
  return emails.length > 0 ? { ...pending, emails } : null
}

/** The owner's known emails from /api/login/repair/known. */
export function accountsFromKnown(payload) {
  const accounts = bodyOf(payload).accounts
  return Array.isArray(accounts) ? accounts : []
}
