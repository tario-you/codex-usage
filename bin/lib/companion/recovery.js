import { randomUUID } from 'node:crypto'
import { CONTINUATION, RETRY_DELAYS, transientFailure, unchangedFailure } from './policy.js'

export class RecoveryCompanion {
  constructor({ send, store, now = Date.now, delays = RETRY_DELAYS, timeoutMs = 15_000, pid = process.pid }) {
    Object.assign(this, { send, store, now, delays, timeoutMs, pid })
    this.id = randomUUID(); this.sequence = 0; this.ready = false; this.closed = false
    this.pending = new Map(); this.clientRequests = new Map(); this.approvals = new Map()
    this.blocked = new Set()
    this.tasks = new Map(); this.generations = new Map(); this.timers = new Map(); this.working = new Set()
    this.flush()
  }
  flush() {
    try { this.store.status(this.id, { pid: this.pid, connected: !this.closed, at: this.now(), ready: this.ready, tasks: [...this.tasks.values()].slice(-100) }) } catch { /* A status write cannot stop the app-server connection. */ }
  }
  note(threadId, state) {
    this.tasks.delete(threadId); this.tasks.set(threadId, { threadId, state, at: this.now() })
    if (this.tasks.size > 100) this.tasks.delete(this.tasks.keys().next().value)
    this.flush()
  }
  cancel(threadId) {
    this.generations.set(threadId, (this.generations.get(threadId) || 0) + 1)
    clearTimeout(this.timers.get(threadId)); this.timers.delete(threadId)
  }
  fromClient(message) {
    if (message.method === 'initialized') this.ready = true
    if (message.id != null && message.method) {
      if (message.method === 'initialize') this.clientRequests.set(message.id, 'initialize')
      const id = message.params?.threadId
      if (id && message.method === 'turn/start') this.blocked.delete(id)
      if (id && (['turn/interrupt', 'thread/archive', 'thread/close'].includes(message.method) || message.method === 'thread/goal/set' && message.params?.status === 'paused')) this.blocked.add(id)
      if (id && !['thread/read', 'thread/turns/list', 'thread/items/list'].includes(message.method)) {
        this.cancel(id)
        this.note(id, message.method === 'turn/interrupt' ? 'Stopped by you' : 'Controlled by Codex')
      }
    }
    if (message.id != null && !message.method) this.approvals.delete(message.id)
  }
  fromServer(message) {
    const pending = this.pending.get(message.id)
    if (pending && !message.method) {
      this.pending.delete(message.id); clearTimeout(pending.timer)
      message.error ? pending.reject(new Error('Codex refused the recovery request')) : pending.resolve(message.result)
      return true // Only responses to our own IDs are consumed.
    }
    if (!message.method && typeof message.id === 'string' && message.id.startsWith(`usage-companion:${this.id}:`)) return true
    if (this.clientRequests.get(message.id) === 'initialize' && !message.method) {
      this.clientRequests.delete(message.id); this.ready = !message.error
    }
    const id = message.params?.threadId
    if (message.method && message.id != null) {
      // Forward every server request unchanged. Never manufacture an approval,
      // answer a clarification, or respond to dynamic tools on the app's behalf.
      this.approvals.set(message.id, id ?? null)
      if (id) { this.cancel(id); this.note(id, 'Needs your input in Codex') }
    }
    if (message.method === 'serverRequest/resolved') this.approvals.delete(message.params?.requestId)
    if (id && message.method === 'turn/started') { this.cancel(id); this.note(id, 'Running') }
    if (id && ['thread/archived', 'thread/closed', 'thread/goal/updated'].includes(message.method)) {
      this.cancel(id)
      if (message.method !== 'thread/goal/updated' || message.params?.goal?.status === 'paused') this.blocked.add(id)
      this.note(id, 'Controlled by Codex')
    }
    if (id && message.method === 'turn/completed') {
      this.cancel(id)
      const turn = message.params.turn
      if (turn?.status === 'interrupted' || turn?.status === 'failed' && !transientFailure(turn)) this.blocked.add(id)
      if (transientFailure(turn)) this.schedule(id, turn.id)
      else this.note(id, turn?.status === 'completed' ? 'Completed' : 'Needs your attention')
    }
    return false
  }
  schedule(threadId, turnId) {
    if (this.blocked.has(threadId) || !this.ready || this.closed || typeof turnId !== 'string' || !this.store.enabled()) return
    if ([...this.approvals.values()].some(id => id === threadId || id === null)) return
    const attempts = this.store.attempts(threadId, this.now())
    if (attempts.some(r => r.turnId === turnId) || attempts.length >= this.delays.length) {
      this.note(threadId, 'Retry limit reached — open Codex'); return
    }
    const generation = this.generations.get(threadId)
    this.note(threadId, `Retry ${attempts.length + 1} in ${Math.ceil(this.delays[attempts.length] / 1000)}s`)
    this.timers.set(threadId, setTimeout(() => {
      this.timers.delete(threadId)
      void this.retry(threadId, turnId, generation).catch(() => this.note(threadId, 'Recovery unavailable — open Codex'))
    }, this.delays[attempts.length]))
  }
  canRetry(threadId, generation) {
    return !this.blocked.has(threadId) && !this.closed && this.ready && this.store.enabled() && this.generations.get(threadId) === generation
      && ![...this.approvals.values()].some(id => id === threadId || id === null)
  }
  async retry(threadId, turnId, generation) {
    if (!this.canRetry(threadId, generation) || this.working.has(threadId)) return
    this.working.add(threadId)
    try {
      const { thread } = await this.request('thread/read', { threadId, includeTurns: true })
      if (!this.canRetry(threadId, generation)) return
      if (!unchangedFailure(thread, turnId)) { this.note(threadId, 'Task changed — retry canceled'); return }
      if (!this.store.claim(threadId, turnId, this.now())) { this.note(threadId, 'Retry already handled or limit reached'); return }
      // This is the original live connection. No fork, detached runner, model,
      // permission, sandbox, account, or working-directory override is sent.
      const result = await this.request('turn/start', { threadId, input: [{ type: 'text', text: CONTINUATION }] })
      if (!result?.turn?.id) throw new Error('No recovery turn returned')
      // A completion can precede the response; do not overwrite its status.
      if (this.tasks.get(threadId)?.state.startsWith('Retry ')) this.note(threadId, 'Resumed')
    } finally { this.working.delete(threadId) }
  }
  request(method, params) {
    const id = `usage-companion:${this.id}:${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Recovery request timed out')) }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, params }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  close() {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Connection closed')) }
    this.pending.clear(); this.flush()
  }
}
