import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveDefaultSwitcherStorePath } from './login-file.js'

/**
 * The owner's local switcher (Codex Switchboard) logs every switch, task
 * continuation and desktop relaunch to its activity file. The dashboard sync
 * uploads new entries so the switch history shows this machine too.
 */
export const SWITCHBOARD_ACTIVITY_PATH = path.join(
  os.homedir(),
  '.local/state/codex-auto-switch/activity.json',
)

const KIND_BY_TYPE = {
  switched: 'switched',
  resumed: 'resumed',
  'desktop-relaunched': 'relaunched',
}

export function readSwitchboardActivity(activityPath = SWITCHBOARD_ACTIVITY_PATH) {
  if (!existsSync(activityPath)) return []
  try {
    const entries = JSON.parse(readFileSync(activityPath, 'utf8'))
    return Array.isArray(entries) ? entries : []
  } catch {
    return []
  }
}

export function readSwitcherEmails(storePath = resolveDefaultSwitcherStorePath()) {
  if (!existsSync(storePath)) return new Map()
  try {
    const store = JSON.parse(readFileSync(storePath, 'utf8'))
    return new Map(
      (store.accounts ?? []).map((account) => [account.id, account.email ?? null]),
    )
  } catch {
    return new Map()
  }
}

/** Activity entries newer than the watermark, oldest first, as upload payloads. */
export function buildSwitchEventUpload({ entries, emailsById, uploadedAt }) {
  const newest = uploadedAt ? Date.parse(uploadedAt) : 0
  const events = []
  let previousEmail = null
  for (const entry of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    const kind = KIND_BY_TYPE[entry.type]
    if (!kind) continue
    const email = entry.accountId ? emailsById.get(entry.accountId) ?? null : null
    if (kind === 'switched' && !email) continue
    const at = Date.parse(entry.at)
    if (!Number.isFinite(at)) continue
    const event = {
      kind,
      fromEmail: kind === 'switched' ? previousEmail : null,
      toEmail: kind === 'switched' ? email : null,
      reason: entry.message ?? null,
      occurredAt: new Date(at).toISOString(),
    }
    if (kind === 'switched') previousEmail = email
    if (at > newest) events.push(event)
  }
  return events
}

export async function uploadSwitchEvents({ config, fetcher = fetch }) {
  if (!config?.syncUrl || !config?.deviceToken) return { uploaded: 0, uploadedAt: config?.switchEventsUploadedAt ?? null }
  const events = buildSwitchEventUpload({
    entries: readSwitchboardActivity(),
    emailsById: readSwitcherEmails(),
    uploadedAt: config.switchEventsUploadedAt ?? null,
  })
  if (events.length === 0) return { uploaded: 0, uploadedAt: config.switchEventsUploadedAt ?? null }
  const response = await fetcher(new URL('/api/login/switches', config.syncUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceToken: config.deviceToken, events }),
  })
  if (!response.ok) {
    throw new Error(`Switch history upload failed (HTTP ${response.status}).`)
  }
  return { uploaded: events.length, uploadedAt: events[events.length - 1].occurredAt }
}
