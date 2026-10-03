import assert from 'node:assert/strict'
import test from 'node:test'

import { IDLE_POLL_SECONDS, createWakeListener } from '../bin/lib/wake.js'

const channel = { apikey: 'fixture-anon', topic: 'wake-fixture', url: 'wss://fixture.invalid/realtime/v1/websocket' }

class FakeSocket {
  static all = []
  constructor(url) {
    this.url = url
    this.sent = []
    this.closed = false
    this.answersHeartbeats = true
    FakeSocket.all.push(this)
  }
  send(data) {
    const message = JSON.parse(data)
    this.sent.push(message)
    if (message.event === 'heartbeat' && this.answersHeartbeats) {
      this.receive({ event: 'phx_reply', payload: { response: {}, status: 'ok' }, ref: message.ref, topic: 'phoenix' })
    }
  }
  close() { this.closed = true }
  open() { this.onopen?.() }
  receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  join(status = 'ok') {
    this.open()
    const join = this.sent.find(m => m.event === 'phx_join')
    this.receive({ event: 'phx_reply', payload: { response: {}, status }, ref: join.ref, topic: join.topic })
  }
  wake() { this.receive({ event: 'broadcast', payload: { event: 'wake', payload: {} }, topic: `realtime:${channel.topic}` }) }
}

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  FakeSocket.all = []
  const wake = createWakeListener({ WebSocketImpl: FakeSocket })
  t.after(() => wake.close())
  return wake
}

/** The wait's reason once it ends; 'pending' until then. */
function track(promise) {
  const state = { reason: 'pending' }
  void promise.then(reason => { state.reason = reason })
  return state
}

/** Advance mocked time and let the resolved waits settle. */
async function advance(t, ms) {
  t.mock.timers.tick(ms)
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('without a wake channel an agent keeps its own fast interval and opens no socket', async (t) => {
  const wake = setup(t)
  wake.update(undefined)
  const waiting = track(wake.wait(5_000))
  await advance(t, 4_999)
  assert.equal(waiting.reason, 'pending')
  await advance(t, 1)
  assert.equal(waiting.reason, 'idle')
  assert.equal(FakeSocket.all.length, 0)
})

test('naming a channel opens no socket until a loop waits, so one-shot commands can exit', (t) => {
  const wake = setup(t)
  wake.update(channel)
  assert.equal(FakeSocket.all.length, 0)
  void wake.wait(5_000)
  assert.equal(FakeSocket.all.length, 1)
  assert.equal(FakeSocket.all[0].url, `${channel.url}?apikey=fixture-anon&vsn=1.0.0`)
})

test('a joined agent polls on a wake at once and otherwise only every IDLE_POLL_SECONDS', async (t) => {
  const wake = setup(t)
  wake.update(channel)
  // The join itself wakes once: a click made while the socket was down woke nobody.
  const catchUp = track(wake.wait(5_000))
  FakeSocket.all[0].join()
  await advance(t, 0)
  assert.equal(catchUp.reason, 'wake')

  const idle = track(wake.wait(5_000))
  await advance(t, 60_000)
  assert.equal(idle.reason, 'pending', 'a joined agent no longer polls every 5 s')
  await advance(t, IDLE_POLL_SECONDS * 1000 - 60_000)
  assert.equal(idle.reason, 'idle')

  const click = track(wake.wait(5_000))
  await advance(t, 30_000)
  assert.equal(click.reason, 'pending')
  FakeSocket.all[0].wake()
  await advance(t, 0)
  assert.equal(click.reason, 'wake')
})

test('a wake that lands while the loop is polling ends its next wait at once', async (t) => {
  const wake = setup(t)
  wake.update(channel)
  void wake.wait(5_000)
  FakeSocket.all[0].join()
  await advance(t, 0)
  await advance(t, 1_000)
  FakeSocket.all[0].wake()
  const next = track(wake.wait(5_000))
  await advance(t, 0)
  assert.equal(next.reason, 'wake')
})

test('wakes never make a loop poll more than once a second', async (t) => {
  const wake = setup(t)
  wake.update(channel)
  void wake.wait(5_000)
  FakeSocket.all[0].join()
  await advance(t, 0)
  const flooded = track(wake.wait(5_000))
  FakeSocket.all[0].wake()
  await advance(t, 999)
  assert.equal(flooded.reason, 'pending')
  await advance(t, 1)
  assert.equal(flooded.reason, 'wake')
})

test('a socket that drops or stops answering falls back to the fast interval and reconnects', async (t) => {
  const wake = setup(t)
  wake.update(channel)
  void wake.wait(5_000)
  FakeSocket.all[0].join()
  await advance(t, 1_000)
  assert.equal(wake.joined, true)

  FakeSocket.all[0].onclose()
  assert.equal(wake.joined, false)
  const fast = track(wake.wait(5_000))
  await advance(t, 5_000)
  assert.equal(fast.reason, 'idle')
  assert.equal(FakeSocket.all.length, 2, 'reconnects after the first backoff')

  FakeSocket.all[1].join()
  await advance(t, 1_000)
  assert.equal(wake.joined, true)
  await advance(t, 50_000)
  assert.equal(wake.joined, true, 'answered heartbeats keep the channel')
  // Heartbeats go out every 25 s; one left unanswered drops the socket.
  FakeSocket.all[1].answersHeartbeats = false
  await advance(t, 50_000)
  assert.equal(wake.joined, false)
  assert.equal(FakeSocket.all[1].closed, true)
})

test('a refused join or a foreign topic never counts as joined or as a wake', async (t) => {
  const wake = setup(t)
  wake.update(channel)
  const waiting = track(wake.wait(5_000))
  FakeSocket.all[0].open()
  FakeSocket.all[0].receive({ event: 'broadcast', payload: { event: 'wake' }, topic: 'realtime:someone-else' })
  FakeSocket.all[0].join('error')
  assert.equal(wake.joined, false)
  await advance(t, 4_000)
  assert.equal(waiting.reason, 'pending')
  await advance(t, 1_000)
  assert.equal(waiting.reason, 'idle')
})

test('maxMs caps a joined wait for a loop with its own deadline, and close ends every wait', async (t) => {
  const wake = setup(t)
  wake.update(channel)
  void wake.wait(5_000)
  FakeSocket.all[0].join()
  await advance(t, 1_000)
  const capped = track(wake.wait(20_000, { maxMs: 30_000 }))
  await advance(t, 30_000)
  assert.equal(capped.reason, 'idle')

  const open = track(wake.wait(20_000))
  wake.close()
  await advance(t, 0)
  assert.equal(open.reason, 'closed')
  assert.equal(FakeSocket.all[0].closed, true)
})
