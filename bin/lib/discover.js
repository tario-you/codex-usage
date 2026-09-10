import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { decodeJwtPayload } from './login-file.js'
import { fetchUsage, readStore } from './sync-all.js'

/**
 * A machine already knows which Codex accounts it has used, even when the
 * person does not. `discoverAccounts` reads every local trace that names one:
 * the login Codex holds right now, every backup of that file an earlier switch
 * left behind, the Switchboard store, the Switchboard's own progress and
 * result records, and whatever the dashboard has already seen for this owner.
 * Nothing here talks to the network; `checkSavedLogins` does that once, so a
 * saved login whose refresh is refused shows up as expired next to the ones
 * that were never saved at all.
 */
export const DEFAULT_SWITCHBOARD_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'codex-auto-switch')
export const MAX_SCAN_BYTES = 4 * 1024 * 1024
const AUTH_FILE_PATTERN = /^auth\.json/
const MAX_WALK_DEPTH = 8

function cleanEmail(value) {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.includes('@') && email.length <= 320 ? email : null
}

/** The account a Codex auth file is signed into, or null when it holds none. */
export function loginFromAuthFile(file) {
  const tokens = file?.tokens
  if (!tokens || typeof tokens.id_token !== 'string') return null
  const claims = decodeJwtPayload(tokens.id_token) ?? {}
  const email = cleanEmail(claims.email)
  if (!email) return null
  const auth = claims['https://api.openai.com/auth'] ?? {}
  return {
    accountId: tokens.account_id ?? auth.chatgpt_account_id ?? null,
    at: typeof file.last_refresh === 'string' ? file.last_refresh : null,
    email,
    planType: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null,
  }
}

/** Every object inside a JSON value that carries an `email`, with what sits beside it. */
export function emailsInJson(value, depth = 0, out = []) {
  if (depth > MAX_WALK_DEPTH || !value || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) emailsInJson(item, depth + 1, out)
    return out
  }
  const email = cleanEmail(value.email)
  if (email) {
    const at = [value.at, value.timestamp, value.time, value.updatedAt, value.updated_at, value.last_used_at].find(
      (candidate) => typeof candidate === 'string' && Number.isFinite(Date.parse(candidate)),
    )
    out.push({
      accountId: value.accountId ?? value.account_id ?? null,
      at: at ?? null,
      email,
      planType: value.planType ?? value.plan_type ?? null,
    })
  }
  for (const child of Object.values(value)) emailsInJson(child, depth + 1, out)
  return out
}

async function readSmallJson(filePath) {
  const info = await stat(filePath)
  if (!info.isFile() || info.size > MAX_SCAN_BYTES) return null
  try {
    return { mtime: info.mtime.toISOString(), value: JSON.parse(await readFile(filePath, 'utf8')) }
  } catch {
    return null
  }
}

async function listDir(dir) {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

function later(a, b) {
  if (!a) return b
  if (!b) return a
  return Date.parse(b) > Date.parse(a) ? b : a
}

/**
 * Every account this machine has used, one entry per email, newest first.
 * `known` is what the dashboard already holds for this owner
 * (`{ email, planType, sourceLabel, lastSeenAt, thisDevice }`).
 */
export async function discoverAccounts({
  codexHome,
  storePath,
  stateDir = DEFAULT_SWITCHBOARD_STATE_DIR,
  known = [],
}) {
  const found = new Map()
  const add = (email, source, { accountId = null, at = null, planType = null } = {}) => {
    let entry = found.get(email)
    if (!entry) {
      entry = { accountId: null, email, lastSeenAt: null, planType: null, saved: null, sources: [] }
      found.set(email, entry)
    }
    if (accountId && !entry.accountId) entry.accountId = accountId
    if (planType && !entry.planType) entry.planType = planType
    entry.lastSeenAt = later(entry.lastSeenAt, at)
    if (!entry.sources.some((existing) => existing.kind === source.kind && existing.detail === source.detail)) {
      entry.sources.push({ ...source, at })
    }
    return entry
  }

  for (const name of (await listDir(codexHome)).filter((entry) => AUTH_FILE_PATTERN.test(entry)).sort()) {
    const file = await readSmallJson(path.join(codexHome, name))
    const login = file && loginFromAuthFile(file.value)
    if (!login) continue
    add(
      login.email,
      { detail: name, kind: name === 'auth.json' ? 'current Codex login' : 'earlier Codex login' },
      { accountId: login.accountId, at: login.at ?? file.mtime, planType: login.planType },
    )
  }

  const store = await readStore(storePath)
  for (const account of store.accounts) {
    const email = cleanEmail(account.email) ?? loginFromAuthFile({ tokens: account.auth_data })?.email
    if (!email) continue
    const entry = add(
      email,
      { detail: path.basename(storePath), kind: 'saved login' },
      {
        accountId: account.auth_data?.account_id ?? null,
        at: account.last_used_at ?? account.created_at ?? null,
        planType: account.plan_type ?? null,
      },
    )
    entry.saved = account
  }

  for (const name of (await listDir(stateDir)).filter((entry) => entry.endsWith('.json')).sort()) {
    const file = await readSmallJson(path.join(stateDir, name))
    if (!file) continue
    for (const hit of emailsInJson(file.value)) {
      add(hit.email, { detail: name, kind: 'Switchboard record' }, { ...hit, at: hit.at ?? file.mtime })
    }
  }

  for (const item of known ?? []) {
    const email = cleanEmail(item?.email)
    if (!email) continue
    add(
      email,
      {
        detail: item.sourceLabel ?? null,
        kind: item.thisDevice ? 'reported by this machine' : `held on ${item.sourceLabel ?? 'another machine'}`,
      },
      { at: item.lastSeenAt ?? null, planType: item.planType ?? null },
    )
  }

  return [...found.values()].sort((a, b) => {
    const byTime = (Date.parse(b.lastSeenAt ?? '') || 0) - (Date.parse(a.lastSeenAt ?? '') || 0)
    return byTime !== 0 ? byTime : a.email.localeCompare(b.email)
  })
}

/**
 * One usage call per saved login: `ok` with its usage, `expired` when OpenAI
 * refuses the refresh (a fresh sign-in is the only fix), `error` otherwise.
 * Accounts that were never saved are `missing`.
 */
export async function checkSavedLogins(candidates, fetcher = fetch) {
  const statuses = new Map()
  for (const candidate of candidates) {
    const tokens = candidate.saved?.auth_data
    if (!tokens?.access_token || !tokens?.refresh_token || !tokens?.account_id) {
      statuses.set(candidate.email, { status: 'missing' })
      continue
    }
    const usage = await fetchUsage(tokens, fetcher)
    if (usage.error) {
      statuses.set(candidate.email, {
        detail: usage.error,
        status: /sign-in expired/i.test(usage.error) ? 'expired' : 'error',
      })
      continue
    }
    statuses.set(candidate.email, {
      planType: usage.data.plan_type ?? candidate.planType ?? null,
      status: 'ok',
      usedPercent: usage.data.rate_limit?.primary_window?.used_percent ?? null,
    })
  }
  return statuses
}

/** The sign-ins `login setup` walks through, in discovery order: never saved first, then expired. */
export function setupPlan(candidates, statuses) {
  const missing = []
  const expired = []
  for (const candidate of candidates) {
    const status = statuses.get(candidate.email)?.status ?? 'missing'
    if (status === 'missing') missing.push({ email: candidate.email, why: 'never signed in here' })
    else if (status === 'expired') expired.push({ email: candidate.email, why: 'sign-in expired' })
  }
  return [...missing, ...expired]
}

/** Accounts the machine has used and never saved: what the dashboard shows as "found, not signed in". */
export function missingEmails(candidates) {
  return candidates.filter((candidate) => !candidate.saved).map((candidate) => candidate.email)
}

export function describeSources(candidate) {
  return candidate.sources.map((source) => (source.detail ? `${source.kind} (${source.detail})` : source.kind)).join(', ')
}
