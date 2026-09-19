import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dashboardRequest } from './dashboard-request.js'
import {
  decodeJwtPayload,
  findSwitcherStoreAccount,
  resolveAuthFilePath,
  resolveDefaultSwitcherStorePath,
} from './login-file.js'

/**
 * One-click plan switching from the dashboard. The owner clicks "Use" on a
 * Plans row; this machine's watch loop polls `/api/login/switch/poll`, finds
 * the request, and asks the local Codex Switchboard (the menu-bar service
 * that owns the desktop app's login) to make that account active. Switchboard
 * refuses while a task is running or when the desktop is not wrapped, and
 * that refusal is what the dashboard shows. The active login is reported on
 * every poll so the dashboard can mark the row.
 */
export const SWITCHBOARD_STATE_DIR = path.join(os.homedir(), '.local/state/codex-auto-switch')
export const PLAN_SWITCH_POLL_SECONDS = 15
/** Switchboard itself waits up to 60 s for the desktop wrapper to answer. */
const SWITCHBOARD_REQUEST_TIMEOUT_MS = 90_000

function readJsonQuietly(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The running Switchboard's local origin and bearer token, or null when it is not running. */
export function readSwitchboardEndpoint(stateDir = SWITCHBOARD_STATE_DIR) {
  const dashboard = readJsonQuietly(path.join(stateDir, 'dashboard.json'))
  const key = readJsonQuietly(path.join(stateDir, 'dashboard-key.json'))
  if (!dashboard?.origin || typeof key?.token !== 'string' || !key.token) return null
  let origin
  try {
    origin = new URL(dashboard.origin)
  } catch {
    return null
  }
  if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:') return null
  if (Number.isSafeInteger(dashboard.pid)) {
    try {
      process.kill(dashboard.pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return null
    }
  }
  return { origin: origin.origin, token: key.token }
}

/** The email of the login Codex is signed into on this machine, or null. */
export function readActiveEmail(codexHome) {
  const file = readJsonQuietly(resolveAuthFilePath(codexHome))
  if (!file || (file.auth_mode && file.auth_mode !== 'chatgpt')) return null
  const tokens = file.tokens ?? {}
  const access = decodeJwtPayload(tokens.access_token) ?? {}
  const id = decodeJwtPayload(tokens.id_token) ?? {}
  const email = access['https://api.openai.com/profile']?.email ?? id.email
  return typeof email === 'string' && email.includes('@') ? email.trim().toLowerCase() : null
}

/** The pending request from a poll response, or null. */
export function pendingSwitchFromPoll(payload) {
  const pending = payload && typeof payload === 'object' ? payload.pending : null
  if (!pending || typeof pending !== 'object') return null
  const email = typeof pending.email === 'string' ? pending.email.trim().toLowerCase() : ''
  const requestId = typeof pending.requestId === 'string' ? pending.requestId : null
  return email.includes('@') && requestId ? { email, requestId } : null
}

/**
 * Switch this machine's Codex login through Switchboard. Resolves to the
 * email Switchboard reports; rejects with the reason it refused.
 */
export async function switchThroughSwitchboard({
  email,
  fetcher = fetch,
  stateDir = SWITCHBOARD_STATE_DIR,
  storePath = resolveDefaultSwitcherStorePath(),
}) {
  const endpoint = readSwitchboardEndpoint(stateDir)
  if (!endpoint) {
    throw new Error('Codex Switchboard is not running on this machine; open it and try again.')
  }
  const store = readJsonQuietly(storePath)
  const account = store ? findSwitcherStoreAccount(store, email) : null
  if (!account?.id) {
    throw new Error(`No saved login for ${email} on this machine; sign it in with login setup first.`)
  }
  const response = await fetcher(`${endpoint.origin}/api/switch`, {
    body: JSON.stringify({ id: account.id }),
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(SWITCHBOARD_REQUEST_TIMEOUT_MS),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error ?? `Switchboard refused the switch (HTTP ${response.status}).`)
  }
  return { email: typeof payload?.email === 'string' ? payload.email.toLowerCase() : email }
}

async function readBody(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function pollPlanSwitch({ activeEmail, config, fetcher = fetch }) {
  const response = await fetcher(
    new URL('/api/login/switch/poll', config.syncUrl),
    dashboardRequest({ activeEmail, deviceToken: config.deviceToken }),
  )
  const payload = await readBody(response)
  if (!response.ok) throw new Error(payload?.error ?? `Plan switch poll failed (HTTP ${response.status}).`)
  return pendingSwitchFromPoll(payload)
}

export async function reportPlanSwitch({ config, fetcher = fetch, result }) {
  const response = await fetcher(
    new URL('/api/login/switch/done', config.syncUrl),
    dashboardRequest({ deviceToken: config.deviceToken, ...result }),
  )
  const payload = await readBody(response)
  if (!response.ok) throw new Error(payload?.error ?? `Plan switch report failed (HTTP ${response.status}).`)
}

/**
 * One pass of the watch loop: report the active login, run a requested
 * switch, report its outcome. Never throws; problems go to `log`, and a
 * failed switch is reported to the dashboard so the row explains itself.
 * Returns true when a switch happened, so the caller can sync right away.
 */
export async function runPlanSwitchPass({
  codexHome,
  config,
  fetcher = fetch,
  log = (message) => console.error(message),
  stateDir = SWITCHBOARD_STATE_DIR,
  storePath = resolveDefaultSwitcherStorePath(),
  switcher = switchThroughSwitchboard,
}) {
  if (!config?.syncUrl || !config?.deviceToken) return false
  let pending
  try {
    pending = await pollPlanSwitch({ activeEmail: readActiveEmail(codexHome), config, fetcher })
  } catch (error) {
    log(`[plan switch] ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  if (!pending) return false
  const active = readActiveEmail(codexHome)
  let result
  if (active === pending.email) {
    result = { email: pending.email, outcome: 'switched', detail: 'already active', requestId: pending.requestId }
  } else {
    log(`The dashboard asked to switch Codex to ${pending.email}.`)
    try {
      const switched = await switcher({ email: pending.email, fetcher, stateDir, storePath })
      result = { email: switched.email, outcome: 'switched', detail: null, requestId: pending.requestId }
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      log(`[plan switch] ${detail}`)
      result = { email: pending.email, outcome: 'failed', detail, requestId: pending.requestId }
    }
  }
  try {
    await reportPlanSwitch({ config, fetcher, result })
  } catch (error) {
    log(`[plan switch] ${error instanceof Error ? error.message : String(error)}`)
  }
  return result.outcome === 'switched'
}
