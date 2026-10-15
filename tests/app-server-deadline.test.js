import assert from 'node:assert/strict'
import test from 'node:test'

import { StdioCodexClient } from '../bin/codex-usage.js'

// An app-server that takes requests and never answers, as the rate-limit read
// did for five hours on 2026-10-14 while the sync's latch waited on it
// (her-team#12378).
function silentChild() {
  const child = { killed: false, stdin: { destroyed: false, write: (_line, done) => done?.() } }
  child.kill = () => {
    child.killed = true
  }
  return child
}

test('an unanswered app-server request fails at its deadline and closes the app-server', { timeout: 2000 }, async () => {
  const client = new StdioCodexClient({ codexHome: '/nonexistent', requestTimeoutMs: 50 })
  const child = silentChild()
  client.child = child

  await assert.rejects(client.request('account/rateLimits/read'), (error) => {
    assert.equal(error.code, 'APP_SERVER_TIMEOUT')
    assert.match(error.message, /account\/rateLimits\/read/)
    return true
  })
  assert.equal(client.pending.size, 0, 'nothing waits on it any more')
  assert.equal(client.child, null, 'the next pass starts a fresh app-server')
  assert.equal(child.killed, true)
})

test('an answered request settles once and leaves the app-server running', { timeout: 2000 }, async () => {
  const client = new StdioCodexClient({ codexHome: '/nonexistent', requestTimeoutMs: 50 })
  const child = silentChild()
  client.child = child

  const answer = client.request('account/read', { refreshToken: false })
  client.consumeStdout(`${JSON.stringify({ id: client.requestId, jsonrpc: '2.0', result: { account: null } })}\n`)
  assert.deepEqual(await answer, { account: null })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(child.killed, false, 'its deadline was cleared')
  assert.equal(client.child, child)
})
