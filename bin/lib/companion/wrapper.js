import { spawn } from 'node:child_process'
import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { RecoveryCompanion } from './recovery.js'
import { RecoveryStore } from './store.js'

function tapLines(observe) {
  let buffer = ''
  const decoder = new StringDecoder('utf8')
  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += decoder.write(chunk)
      let boundary
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1)
        let consumed = false
        try { consumed = observe(JSON.parse(line)) === true } catch { /* Forward malformed or unsupported traffic. */ }
        if (!consumed) this.push(line + '\n')
      }
      callback()
    },
    flush(callback) { buffer += decoder.end(); if (buffer) this.push(buffer); callback() },
  })
}

export function wrap(command, args, { root, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (!command) throw new Error('An upstream Codex command is required')
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_USAGE_COMPANION_WRAPPED: '1' } })
  let companion
  let heartbeat
  // Non-app-server commands and nested wrappers are transparent delegates.
  const stdio = args[0] === 'app-server' && !args.slice(1).some(a => ['proxy', 'daemon', 'generate-ts', 'generate-json-schema', '--help'].includes(a))
    && !args.some((a, i) => a === '--listen' && args[i + 1] !== 'stdio://' || a.startsWith('--listen=') && a !== '--listen=stdio://')
  if (stdio && !process.env.CODEX_USAGE_COMPANION_WRAPPED) {
    try {
      const store = new RecoveryStore(root)
      companion = new RecoveryCompanion({ store, send: m => child.stdin.write(JSON.stringify(m) + '\n') })
    } catch { stderr.write('Task companion unavailable; Codex continues without automatic retries.\n') }
  }
  if (companion) {
    stdin.pipe(tapLines(m => companion.fromClient(m))).pipe(child.stdin)
    child.stdout.pipe(tapLines(m => companion.fromServer(m))).pipe(stdout, { end: false })
    heartbeat = setInterval(() => companion.flush(), 10_000)
  } else {
    stdin.pipe(child.stdin); child.stdout.pipe(stdout, { end: false })
  }
  child.stderr.pipe(stderr, { end: false })
  child.stdin.on('error', () => {})
  return new Promise((resolve, reject) => {
    const signal = name => { if (child.exitCode === null) child.kill(name) }
    const sigterm = () => signal('SIGTERM'), sigint = () => signal('SIGINT')
    process.on('SIGTERM', sigterm); process.on('SIGINT', sigint)
    const cleanup = () => {
      clearInterval(heartbeat)
      process.off('SIGTERM', sigterm); process.off('SIGINT', sigint)
      try { companion?.close() } catch { /* Private ledger may be unavailable. */ }
      stdin.unpipe(); stdin.pause()
    }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('exit', (code, exitSignal) => { cleanup(); resolve(code ?? (exitSignal ? 1 : 0)) })
  })
}
