/**
 * Dashboard wake-ups for the agents (issue #65).
 *
 * The agents used to ask the dashboard every 5–20 s whether the owner had
 * clicked anything: about 23k Vercel function calls a day from one Mac, which
 * put the Hobby team at 75% of its Fluid CPU allowance. Now a click broadcasts
 * an empty "wake" on this machine's Supabase Realtime channel, which every
 * poll response names (`wake: { url, apikey, topic }`).
 *
 * While the channel is joined, a loop's `wait` ends on a wake, else after
 * IDLE_POLL_SECONDS. While it is not (an older dashboard, no WebSocket in this
 * Node, the socket down), `wait` keeps the loop's own fast interval, so a
 * broken channel never makes a click slower than before.
 */
export const IDLE_POLL_SECONDS = 90
export const WAKE_EVENT = 'wake'

const HEARTBEAT_MS = 25_000
const FIRST_RETRY_MS = 1_000
const MAX_RETRY_MS = 60_000
// Whatever arrives on the channel, a loop polls at most once a second.
const MIN_WAKE_GAP_MS = 1_000

function sameChannel(a, b) {
  return a?.url === b?.url && a?.apikey === b?.apikey && a?.topic === b?.topic
}

function readChannel(value) {
  if (!value || typeof value !== 'object') return null
  const { apikey, topic, url } = value
  if (typeof apikey !== 'string' || typeof topic !== 'string' || typeof url !== 'string') return null
  // structural: only a WebSocket URL is a channel
  if (!/^wss?:\/\//.test(url)) return null
  return { apikey, topic, url }
}

export function createWakeListener({ WebSocketImpl = globalThis.WebSocket, log = () => {}, now = () => Date.now() } = {}) {
  let channel = null
  let socket = null
  let joined = false
  let closed = false
  let pendingWake = false
  let ref = 0
  let joinRef = null
  let awaitingHeartbeat = null
  let heartbeatTimer = null
  let retryTimer = null
  let retryMs = FIRST_RETRY_MS
  let lastWaitEndedAt = -Infinity
  const waiters = new Set()

  function setJoined(value) {
    if (joined === value) return
    joined = value
    for (const waiter of waiters) waiter.arm()
  }

  function wakeAll() {
    if (waiters.size === 0) {
      pendingWake = true
      return
    }
    for (const waiter of waiters) waiter.wake()
  }

  function teardown() {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
    awaitingHeartbeat = null
    if (socket) {
      const old = socket
      socket = null
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      try {
        old.close()
      } catch {
        /* Already closed. */
      }
    }
    setJoined(false)
  }

  function scheduleRetry() {
    if (closed || !channel || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, retryMs)
    retryTimer.unref?.()
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
  }

  function send(message) {
    try {
      socket?.send(JSON.stringify(message))
    } catch {
      /* The close handler reconnects. */
    }
  }

  function connect() {
    teardown()
    if (closed || !channel || typeof WebSocketImpl !== 'function') return
    const topic = `realtime:${channel.topic}`
    let next
    try {
      next = new WebSocketImpl(`${channel.url}?apikey=${encodeURIComponent(channel.apikey)}&vsn=1.0.0`)
    } catch {
      scheduleRetry()
      return
    }
    socket = next
    next.onopen = () => {
      joinRef = String(++ref)
      send({
        event: 'phx_join',
        payload: { config: { broadcast: { self: false }, presence: { key: '' }, private: false } },
        ref: joinRef,
        topic,
      })
      heartbeatTimer = setInterval(() => {
        if (awaitingHeartbeat) {
          log('The wake channel stopped answering; reconnecting.')
          teardown()
          scheduleRetry()
          return
        }
        awaitingHeartbeat = String(++ref)
        send({ event: 'heartbeat', payload: {}, ref: awaitingHeartbeat, topic: 'phoenix' })
      }, HEARTBEAT_MS)
      heartbeatTimer.unref?.()
    }
    next.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message?.event === 'phx_reply' && message.ref === awaitingHeartbeat) {
        awaitingHeartbeat = null
        return
      }
      if (message?.event === 'phx_reply' && message.ref === joinRef) {
        if (message.payload?.status !== 'ok') {
          teardown()
          scheduleRetry()
          return
        }
        retryMs = FIRST_RETRY_MS
        setJoined(true)
        // A click made while the socket was down sent its wake to nobody.
        wakeAll()
        return
      }
      if (message?.topic !== topic) return
      if (message.event === 'broadcast' && message.payload?.event === WAKE_EVENT) {
        wakeAll()
      } else if (message.event === 'phx_close' || message.event === 'phx_error') {
        teardown()
        scheduleRetry()
      }
    }
    next.onclose = () => {
      if (socket !== next) return
      teardown()
      scheduleRetry()
    }
    next.onerror = () => {
      /* onclose follows. */
    }
  }

  return {
    get joined() {
      return joined
    },

    /** Record the channel a poll response named. The socket opens on the first `wait`, so one-shot commands never hold the process open. */
    update(value) {
      const next = readChannel(value)
      if (sameChannel(channel, next)) return
      channel = next
      clearTimeout(retryTimer)
      retryTimer = null
      retryMs = FIRST_RETRY_MS
      if (!channel) {
        teardown()
        return
      }
      if (socket) connect()
    },

    /**
     * Resolve with 'wake' on a wake, else with 'idle' after IDLE_POLL_SECONDS
     * while joined or `fallbackMs` while not. `maxMs` caps either, for a loop
     * that has its own deadline (the next sync pass).
     */
    wait(fallbackMs, { maxMs = Infinity } = {}) {
      if (!closed && channel && !socket && !retryTimer) connect()
      const started = now()
      return new Promise((resolve) => {
        const waiter = {
          timer: null,
          woken: false,
          arm() {
            if (this.woken) return
            clearTimeout(this.timer)
            const limit = Math.min(joined ? Math.max(fallbackMs, IDLE_POLL_SECONDS * 1000) : fallbackMs, maxMs)
            this.timer = setTimeout(() => finish('idle'), Math.max(0, started + limit - now()))
          },
          wake() {
            if (this.woken) return
            this.woken = true
            clearTimeout(this.timer)
            this.timer = setTimeout(() => finish('wake'), Math.max(0, lastWaitEndedAt + MIN_WAKE_GAP_MS - now()))
          },
          close() {
            finish('closed')
          },
        }
        const finish = (reason) => {
          clearTimeout(waiter.timer)
          if (!waiters.delete(waiter)) return
          lastWaitEndedAt = now()
          resolve(reason)
        }
        waiters.add(waiter)
        if (closed) {
          finish('closed')
        } else if (pendingWake) {
          pendingWake = false
          waiter.wake()
        } else {
          waiter.arm()
        }
      })
    },

    close() {
      closed = true
      clearTimeout(retryTimer)
      retryTimer = null
      teardown()
      for (const waiter of [...waiters]) waiter.close()
    },
  }
}

/** The one listener a process shares: one machine, one device token, one channel. */
export const dashboardWake = createWakeListener({ log: (message) => console.error(`[wake] ${message}`) })
