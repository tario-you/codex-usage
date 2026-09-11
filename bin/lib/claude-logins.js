import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readJsonFile, writeJsonFilePrivately } from './login-file.js'

/**
 * Claude plans beside the Codex ones. `sync --all` reports every Claude login
 * this machine holds: the Claude Code CLI's own sign-in (macOS Keychain, or
 * `~/.claude/.credentials.json` elsewhere), every login saved by
 * claude-auto-switch in `~/.claude-switcher/accounts.json`, and the Claude
 * desktop app's live login while it is running. Each one answers the same
 * usage endpoint the desktop reads, with a 5-hour and a weekly window, so the
 * dashboard's Usable columns fit without a new table.
 */
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
export const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20'
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'
export const CLAUDE_MAIN_LIMIT_ID = 'claude'

export function resolveClaudeStorePath(option) {
  const raw = option ?? path.join(os.homedir(), '.claude-switcher', 'accounts.json')
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw
  return path.resolve(expanded)
}

export function resolveClaudeCredentialsPath(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, '.credentials.json')
}

function oauthFromCredential(parsed) {
  const oauth = parsed?.claudeAiOauth
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null
  return {
    accessToken: oauth.accessToken,
    refreshToken: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : null,
    expiresAt: Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
  }
}

/** The Claude Code CLI's sign-in on macOS: one generic Keychain item, JSON inside. */
export function readKeychainCredential({ exec = execFileSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return null
  try {
    const raw = exec('/usr/bin/security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return oauthFromCredential(JSON.parse(raw.trim()))
  } catch {
    return null
  }
}

/** The Claude desktop app hands each Code session its login in CLAUDE_CODE_OAUTH_TOKEN; read it off a running one. */
export function readDesktopToken({ exec = execFileSync, platform = process.platform } = {}) {
  if (platform !== 'darwin' && platform !== 'linux') return null
  try {
    const table = exec('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    for (const line of table.split('\n')) {
      if (!line.includes('--permission-prompt-tool stdio')) continue
      const pid = Number(line.trim().split(/\s+/)[0])
      if (!Number.isInteger(pid)) continue
      const env = exec('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      const token = (env.match(/CLAUDE_CODE_OAUTH_TOKEN=(\S+)/) || [])[1]
      if (token) return token
    }
  } catch {
    // No desktop app, or no permission to read its environment.
  }
  return null
}

/**
 * Every Claude login this machine can vouch for, in trust order: saved
 * switcher logins first (they carry a refresh token and an email), then the
 * CLI's own sign-in, then the desktop's live token. The same account reached
 * twice is folded later, once its profile names the email.
 */
export async function discoverClaudeLogins({
  storePath = resolveClaudeStorePath(),
  credentialsPath = resolveClaudeCredentialsPath(),
  keychain = readKeychainCredential,
  desktopToken = readDesktopToken,
} = {}) {
  const logins = []
  if (existsSync(storePath)) {
    const store = await readJsonFile(storePath).catch(() => null)
    for (const account of Array.isArray(store?.accounts) ? store.accounts : []) {
      if (!account?.oauth?.accessToken) continue
      logins.push({
        id: String(account.id ?? account.email ?? logins.length),
        source: 'switcher',
        email: typeof account.email === 'string' ? account.email.toLowerCase() : null,
        oauth: {
          accessToken: account.oauth.accessToken,
          refreshToken: account.oauth.refreshToken ?? null,
          expiresAt: account.oauth.expiresAt ?? null,
          subscriptionType: account.subscription_type ?? account.oauth.subscriptionType ?? null,
        },
      })
    }
  }
  let cli = null
  if (existsSync(credentialsPath)) {
    cli = oauthFromCredential(await readJsonFile(credentialsPath).catch(() => null))
  }
  if (!cli) cli = keychain()
  if (cli) logins.push({ id: 'cli', source: 'cli', email: null, oauth: cli })
  const desktop = desktopToken()
  if (desktop) {
    logins.push({ id: 'desktop', source: 'desktop', email: null, oauth: { accessToken: desktop, refreshToken: null, expiresAt: null, subscriptionType: null } })
  }
  // The same token reached through two doors is one login.
  const seen = new Set()
  return logins.filter((login) => {
    if (seen.has(login.oauth.accessToken)) return false
    seen.add(login.oauth.accessToken)
    return true
  })
}

function headers(accessToken) {
  return { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': CLAUDE_OAUTH_BETA }
}

async function readJson(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** One refresh through the public Claude Code client; null when the refresh token is dead. */
export async function refreshClaudeOauth(oauth, fetcher = fetch) {
  if (!oauth?.refreshToken) return null
  const response = await fetcher(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await readJson(response)
  if (!response.ok || typeof body?.access_token !== 'string') return null
  return {
    ...oauth,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : oauth.refreshToken,
    expiresAt: Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000,
  }
}

/** Usage for one Claude login. A 401 gets one token refresh when a refresh token exists, then one retry. */
export async function fetchClaudeUsage(oauth, fetcher = fetch) {
  const call = (current) => fetcher(CLAUDE_USAGE_URL, { headers: headers(current.accessToken), signal: AbortSignal.timeout(20_000) })
  let current = oauth
  let refreshed = false
  let response = await call(current)
  if (response.status === 401) {
    const next = await refreshClaudeOauth(current, fetcher)
    if (!next) return { error: 'sign-in expired; sign in to Claude Code again on this machine' }
    current = next
    refreshed = true
    response = await call(current)
  }
  if (!response.ok) return { error: `usage request failed (HTTP ${response.status})` }
  return { data: await readJson(response), oauth: current, refreshed }
}

export async function fetchClaudeProfile(oauth, fetcher = fetch) {
  const response = await fetcher(CLAUDE_PROFILE_URL, { headers: headers(oauth.accessToken), signal: AbortSignal.timeout(20_000) })
  const body = await readJson(response)
  if (!response.ok) return null
  const organizationType = typeof body?.organization?.organization_type === 'string' ? body.organization.organization_type : null
  return {
    email: typeof body?.account?.email === 'string' ? body.account.email.toLowerCase() : null,
    organizationType,
    planType: oauth.subscriptionType ?? (organizationType ? organizationType.replace(/^claude_/, '') : null),
  }
}

function windowValue(entry, windowDurationMins) {
  if (!entry || typeof entry.utilization !== 'number') return null
  const resetMs = typeof entry.resets_at === 'string' ? Date.parse(entry.resets_at) : Number.NaN
  return {
    resetsAt: Number.isFinite(resetMs) ? Math.floor(resetMs / 1000) : null,
    usedPercent: Math.max(0, Math.min(100, entry.utilization)),
    windowDurationMins,
  }
}

/** The dashboard's sync payload, built from Claude's usage endpoint response. */
export function buildClaudeSyncPayload(data, { email = null, planType = null } = {}) {
  const credits = { balance: '0', hasCredits: false, unlimited: false }
  const main = {
    credits,
    limitId: CLAUDE_MAIN_LIMIT_ID,
    limitName: 'Claude',
    planType,
    primary: windowValue(data?.five_hour, 300),
    secondary: windowValue(data?.seven_day, 10080),
  }
  const byLimitId = { [CLAUDE_MAIN_LIMIT_ID]: main }
  for (const [key, name] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']]) {
    const secondary = windowValue(data?.[key], 10080)
    if (secondary) byLimitId[`claude_${name.toLowerCase()}`] = { credits, limitId: `claude_${name.toLowerCase()}`, limitName: name, planType, primary: null, secondary }
  }
  return {
    accountState: {
      account: { type: 'claude', ...(email ? { email } : {}), ...(planType ? { planType } : {}) },
      requiresOpenaiAuth: false,
    },
    rateLimits: { rateLimits: main, rateLimitsByLimitId: byLimitId },
  }
}

/** Refreshed switcher tokens go back to the store as it is on disk at write time. */
async function writeBackSwitcherOauth(storePath, login) {
  if (!existsSync(storePath)) return
  const latest = await readJsonFile(storePath).catch(() => null)
  const account = Array.isArray(latest?.accounts) ? latest.accounts.find((entry) => String(entry.id) === login.id) : null
  if (!account) return
  account.oauth = { ...(account.oauth ?? {}), accessToken: login.oauth.accessToken, refreshToken: login.oauth.refreshToken, expiresAt: login.oauth.expiresAt }
  await writeJsonFilePrivately(storePath, latest)
}

/**
 * Report every Claude login once. Logins that name the same email are one
 * account; the one carrying a refresh token wins so an expired token can be
 * renewed next pass.
 */
export async function syncClaudeOnce({ config, device, fetcher = fetch, logins = null, storePath = resolveClaudeStorePath() }) {
  const found = logins ?? (await discoverClaudeLogins({ storePath }))
  const results = []
  const byEmail = new Map()
  for (const login of found) {
    const profile = await fetchClaudeProfile(login.oauth, fetcher).catch(() => null)
    if (!profile?.email) {
      results.push({ email: login.email, source: login.source, ok: false, reason: 'profile unavailable; the sign-in may have expired' })
      continue
    }
    const known = byEmail.get(profile.email)
    if (!known || (!known.login.oauth.refreshToken && login.oauth.refreshToken)) byEmail.set(profile.email, { login, profile })
  }
  for (const [email, { login, profile }] of byEmail) {
    const usage = await fetchClaudeUsage(login.oauth, fetcher)
    if (usage.error) {
      results.push({ email, source: login.source, ok: false, reason: usage.error })
      continue
    }
    if (usage.refreshed) {
      login.oauth = usage.oauth
      if (login.source === 'switcher') await writeBackSwitcherOauth(storePath, login).catch(() => {})
    }
    const payload = buildClaudeSyncPayload(usage.data, { email, planType: profile.planType })
    const response = await fetcher(config.syncUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, device, deviceToken: config.deviceToken }),
    })
    if (!response.ok) {
      results.push({ email, source: login.source, ok: false, reason: `dashboard rejected the sync (HTTP ${response.status})` })
      continue
    }
    results.push({
      email,
      source: login.source,
      ok: true,
      planType: profile.planType,
      usedPercent: payload.rateLimits.rateLimits.primary?.usedPercent ?? null,
      weeklyUsedPercent: payload.rateLimits.rateLimits.secondary?.usedPercent ?? null,
    })
  }
  return { results, synced: results.filter((result) => result.ok).length, total: found.length }
}
