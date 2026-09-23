import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RETRY_WINDOW_MS } from './policy.js'

export const stateRoot = () => process.env.CODEX_COMPANION_STATE_DIR || path.join(os.homedir(), '.local/state/codex-usage-companion')
export function privateJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temp, file)
}
export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}
export class RecoveryStore {
  constructor(root = stateRoot()) { this.root = root; mkdirSync(root, { recursive: true, mode: 0o700 }) }
  file(threadId) { return path.join(this.root, 'retries', createHash('sha256').update(threadId).digest('hex') + '.json') }
  attempts(threadId, now) {
    const records = readJson(this.file(threadId), [])
    if (!Array.isArray(records) || records.some(r => typeof r.turnId !== 'string' || !Number.isFinite(r.at))) throw new Error('Invalid recovery ledger')
    return records.filter(r => now - r.at < RETRY_WINDOW_MS)
  }
  claim(threadId, turnId, now) {
    const file = this.file(threadId)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    let fd
    try { fd = openSync(`${file}.lock`, 'wx', 0o600) } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    }
    try {
      const records = this.attempts(threadId, now)
      if (records.length >= 3 || records.some(r => r.turnId === turnId)) return false
      privateJson(file, [...records, { turnId, at: now }])
      return true
    } finally { closeSync(fd); unlinkSync(`${file}.lock`) }
  }
  enabled() { return readJson(path.join(this.root, 'settings.json'), { enabled: true }).enabled === true }
  status(id, value) { privateJson(path.join(this.root, 'connections', `${id}.json`), value) }
}
