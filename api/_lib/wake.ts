import { createHmac } from 'node:crypto'

import { serverEnv } from './env.js'

/**
 * Agents used to ask the dashboard every 5–20 s whether the owner had clicked
 * anything: about 23k function calls a day from one Mac, which put the Hobby
 * team at 75% of its Fluid CPU allowance on 2026-10-03 (issue #65). Now a
 * click broadcasts an empty "wake" on the clicked machine's Supabase Realtime
 * channel and the agent polls once, right away; between clicks a joined agent
 * polls only every 90 s (bin/lib/wake.js).
 *
 * The channel carries no data, only "poll now", so a public channel with an
 * unguessable name is enough: the name is an HMAC of the device id.
 */
export const WAKE_EVENT = 'wake'

/** How long a machine's helper counts as online: the agent's idle poll (90 s) twice, plus slack. */
export const AGENT_ONLINE_WINDOW_MS = 4 * 60 * 1000

export function wakeTopicFor(deviceId: string) {
  const digest = createHmac('sha256', serverEnv.SUPABASE_SERVICE_ROLE_KEY)
    .update(`codex-usage-wake:${deviceId}`)
    .digest('hex')
  return `wake-${digest.slice(0, 40)}`
}

/** What a poll response tells the agent to listen on, or null when the public key is not configured. */
export function wakeChannelFor(deviceId: string) {
  const apikey = process.env.VITE_SUPABASE_ANON_KEY
  if (!apikey) return null
  return {
    apikey,
    topic: wakeTopicFor(deviceId),
    url: `${serverEnv.SUPABASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket`,
  }
}

/** Tell one machine to poll now. Never throws: its idle poll still finds the request. */
export async function wakeDevice(deviceId: string) {
  try {
    await fetch(`${serverEnv.SUPABASE_URL}/realtime/v1/api/broadcast`, {
      body: JSON.stringify({ messages: [{ event: WAKE_EVENT, payload: {}, topic: wakeTopicFor(deviceId) }] }),
      headers: { apikey: serverEnv.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(3_000),
    })
  } catch {
    /* A missed wake costs at most one idle poll interval. */
  }
}
