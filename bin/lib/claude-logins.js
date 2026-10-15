import { DASHBOARD_UPLOAD_TIMEOUT_MS, dashboardRequest } from './dashboard-request.js'
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

// her-team#12378: claude-auto-switch reads every saved login's usage itself, backing off on 429s, and keeps each
// reading in this file keyed by account, never by token. Two codexusage agents also asked the same endpoint about every
// login each minute, a profile and a usage read apiece, and on 10-15 nearly every read of all three came back 429: the
// switcher could not see a plan with room for 20 minutes at a run-out. A switcher login's row comes from this file.
export const CLAUDE_SWITCHER_READINGS_PATH = path.join(os.homedir(), '.local', 'state', 'claude-auto-switch', 'login-verdicts.json')
// The switcher reads each login at least every 5 minutes; a reading older than this says its tick is not running.
export const SWITCHER_READING_MAX_AGE_MS = 30 * 60_000

const hasNumbers = (verdict) => typeof verdict?.session?.utilization === 'number' || typeof verdict?.weekly?.utilization === 'number'

/** An entry's newest reading with usage numbers in it, the one before a failed read included: { at, verdict }. */
function newestReading(entry) {
  if (hasNumbers(entry?.verdict) && typeof entry.at === 'number') return { at: entry.at, verdict: entry.verdict }
  if (hasNumbers(entry?.lastKnown?.verdict) && typeof entry.lastKnown.at === 'number') return { at: entry.lastKnown.at, verdict: entry.lastKnown.verdict }
  return null
}

async function readSwitcherCache(readingsPath) {
  if (!readingsPath || !existsSync(readingsPath)) return {}
  const cache = await readJsonFile(readingsPath).catch(() => null)
  return cache && typeof cache === 'object' ? cache : {}
}

/** Each saved switcher login's newest reading with usage numbers in it, by login id: { at, verdict }. */
export async function readSwitcherReadings(readingsPath = CLAUDE_SWITCHER_READINGS_PATH) {
  const readings = new Map()
  for (const [key, entry] of Object.entries(await readSwitcherCache(readingsPath))) {
    const newest = key.startsWith('login:') ? newestReading(entry) : null
    if (newest) readings.set(key.slice('login:'.length), newest)
  }
  return readings
}

/**
 * The switcher also reads whatever login the Claude app and the CLI hold each tick, keyed by token with the account's
 * email beside it. Some of those accounts have no saved switcher login: one account is kept out of switching
 * (her-team#6467), so it is read only while the app is signed in to it, and no one can read it after. The newest such
 * reading of each account, by email: { at, verdict }.
 */
export async function readSwitcherReadingsByEmail(readingsPath = CLAUDE_SWITCHER_READINGS_PATH) {
  const readings = new Map()
  for (const [key, entry] of Object.entries(await readSwitcherCache(readingsPath))) {
    if (key.startsWith('login:') || typeof entry?.email !== 'string') continue
    const newest = newestReading(entry)
    const email = entry.email.toLowerCase()
    if (newest && !(readings.get(email)?.at >= newest.at)) readings.set(email, newest)
  }
  return readings
}

/** The usage endpoint's shape, rebuilt from a switcher reading, for buildClaudeSyncPayload. */
export function usageFromReading(verdict) {
  const window = (entry) => (typeof entry?.utilization === 'number' ? { utilization: entry.utilization, resets_at: entry.resetsAt ?? null } : null)
  return { five_hour: window(verdict.session), seven_day: window(verdict.weekly) }
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

/**
 * Usage for one Claude login. A 401 gets one token refresh when a refresh token exists, then one retry.
 * With `refresh: false` it only reads: claude-auto-switch alone renews its logins, so a second renewer
 * never spends a refresh token another process still holds.
 */
export async function fetchClaudeUsage(oauth, fetcher = fetch, { refresh = true } = {}) {
  const call = (current) => fetcher(CLAUDE_USAGE_URL, { headers: headers(current.accessToken), signal: AbortSignal.timeout(20_000) })
  let current = oauth
  let refreshed = false
  let response = await call(current)
  if (response.status === 401) {
    if (!refresh) return { error: 'sign-in expired; claude-auto-switch renews it' }
    const next = await refreshClaudeOauth(current, fetcher)
    if (!next) return { error: 'sign-in expired; sign in to Claude Code again on this machine' }
    current = next
    refreshed = true
    response = await call(current)
  }
  if (!response.ok) return { error: `usage request failed (HTTP ${response.status})` }
  return { data: await readJson(response), oauth: current, refreshed }
}

/** Why a profile read failed: a 401 is an expired sign-in; anything else (a 403 off the system proxy, a 429) says so. */
export function profileFailure(status) {
  return status === 401 ? 'profile unavailable; the sign-in may have expired' : `profile request failed (HTTP ${status})`
}

export async function fetchClaudeProfile(oauth, fetcher = fetch) {
  const response = await fetcher(CLAUDE_PROFILE_URL, { headers: headers(oauth.accessToken), signal: AbortSignal.timeout(20_000) })
  const body = await readJson(response)
  if (!response.ok) return { failure: profileFailure(response.status) }
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

/**
 * her-team#4148: the emails claude-auto-switch can switch to, by its own rule
 * (store.mjs `enabled`: not turned off, and a token it can refresh). Null when
 * this machine has no switcher store, so the dashboard keeps what it knew.
 */
export async function readClaudeAutoSwitchPool(storePath = resolveClaudeStorePath()) {
  if (!existsSync(storePath)) return null
  const store = await readJsonFile(storePath).catch(() => null)
  if (!Array.isArray(store?.accounts)) return null
  const pool = new Set()
  for (const account of store.accounts) {
    if (account?.auto_switch_enabled === false || !account?.oauth?.accessToken || !account?.oauth?.refreshToken) continue
    if (typeof account.email === 'string') pool.add(account.email.toLowerCase())
  }
  return pool
}

/** The dashboard's sync payload, built from Claude's usage endpoint response. `autoSwitch` is left out when unknown. */
export function buildClaudeSyncPayload(data, { email = null, planType = null, autoSwitch = null } = {}) {
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
      account: { type: 'claude', ...(email ? { email } : {}), ...(planType ? { planType } : {}), ...(typeof autoSwitch === 'boolean' ? { autoSwitch: { inPool: autoSwitch } } : {}) },
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
export async function syncClaudeOnce({ config, device, fetcher = fetch, logins = null, storePath = resolveClaudeStorePath(), refresh = true, readingsPath = CLAUDE_SWITCHER_READINGS_PATH, now = Date.now() }) {
  const found = logins ?? (await discoverClaudeLogins({ storePath }))
  const pool = await readClaudeAutoSwitchPool(storePath)
  const readings = await readSwitcherReadings(readingsPath)
  const results = []
  const byEmail = new Map()
  const fromSwitcher = new Map()
  for (const login of found) {
    const reading = login.source === 'switcher' && login.email ? readings.get(login.id) : null
    if (reading && !fromSwitcher.has(login.email)) fromSwitcher.set(login.email, { login, reading })
  }
  for (const login of found) {
    if (login.source === 'switcher' && login.email && fromSwitcher.has(login.email)) continue
    const profile = await fetchClaudeProfile(login.oauth, fetcher).catch((error) => ({ failure: `profile request failed (${error?.cause?.code ?? error?.name ?? 'network'})` }))
    if (!profile?.email) {
      results.push({ email: login.email, source: login.source, ok: false, reason: profile?.failure ?? 'profile unavailable; the sign-in may have expired' })
      continue
    }
    if (fromSwitcher.has(profile.email)) continue
    const known = byEmail.get(profile.email)
    if (!known || (!known.login.oauth.refreshToken && login.oauth.refreshToken)) byEmail.set(profile.email, { login, profile })
  }
  for (const [email, { login, reading }] of fromSwitcher) {
    const ageMs = now - reading.at
    if (ageMs > SWITCHER_READING_MAX_AGE_MS) {
      results.push({ email, source: login.source, ok: false, reason: `claude-auto-switch's newest reading is ${Math.round(ageMs / 60_000)} min old` })
      continue
    }
    byEmail.set(email, { login, profile: { email, planType: login.oauth.subscriptionType ?? null }, usage: { data: usageFromReading(reading.verdict) } })
  }
  const publish = async (email, source, data, { planType = null, readAt } = {}) => {
    const payload = buildClaudeSyncPayload(data, { email, planType, autoSwitch: pool ? pool.has(email) : null })
    const response = await fetcher(
      config.syncUrl,
      dashboardRequest({ ...payload, device, deviceToken: config.deviceToken, ...(readAt ? { readAt } : {}) }, { timeoutMs: DASHBOARD_UPLOAD_TIMEOUT_MS }),
    )
    if (!response.ok) {
      results.push({ email, source, ok: false, reason: `dashboard rejected the sync (HTTP ${response.status})` })
      return
    }
    results.push({
      email,
      source,
      ok: true,
      planType,
      ...(readAt ? { readAt } : {}),
      usedPercent: payload.rateLimits.rateLimits.primary?.usedPercent ?? null,
      weeklyUsedPercent: payload.rateLimits.rateLimits.secondary?.usedPercent ?? null,
    })
  }
  for (const [email, { login, profile, usage: kept }] of byEmail) {
    const usage = kept ?? (await fetchClaudeUsage(login.oauth, fetcher, { refresh }))
    if (usage.error) {
      results.push({ email, source: login.source, ok: false, reason: usage.error })
      continue
    }
    if (usage.refreshed) {
      login.oauth = usage.oauth
      if (login.source === 'switcher') await writeBackSwitcherOauth(storePath, login).catch(() => {})
    }
    await publish(email, login.source, usage.data, { planType: profile.planType })
  }
  // An account the switcher read through the app or the CLI, with no saved login and no live read this pass, goes up
  // with the time its reading was taken; the dashboard keeps whichever of its readings is newer.
  const savedEmails = new Set(found.filter((login) => login.source === 'switcher' && login.email).map((login) => login.email))
  let elsewhere = 0
  for (const [email, reading] of await readSwitcherReadingsByEmail(readingsPath)) {
    if (savedEmails.has(email) || byEmail.has(email)) continue
    elsewhere += 1
    await publish(email, 'app', usageFromReading(reading.verdict), { readAt: Math.min(reading.at, now) })
  }
  return { results, synced: results.filter((result) => result.ok).length, total: found.length + elsewhere }
}
