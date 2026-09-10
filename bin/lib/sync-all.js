import { existsSync } from 'node:fs'
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

/** The dashboard's sync payload, built from the raw usage endpoint response. */
export function buildSyncPayloadFromUsage(data, email = null) {
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
export async function syncAllOnce({ config, storePath, device, fetcher = fetch, activeAuthFile = null }) {
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
    const payload = buildSyncPayloadFromUsage(usage.data, account.email)
    const response = await fetcher(config.syncUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, device, deviceToken: config.deviceToken }),
    })
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
    results,
    storePath,
    synced: results.filter((result) => result.ok).length,
    total: store.accounts.length,
  }
}
