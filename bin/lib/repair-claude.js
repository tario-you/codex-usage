import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const CLAUDE_REPAIR_HELPER = path.join(os.homedir(), '.local/bin/claude-auto-switch')
const STORE = process.env.CLAUDE_SWITCHER_STORE || path.join(os.homedir(), '.claude-switcher/accounts.json')
export const repairProviders = () => existsSync(CLAUDE_REPAIR_HELPER) ? ['codex', 'claude'] : ['codex']

/** Keep authorization URLs private and admit only the Claude login hosts. */
export function claudeSignInUrl(text) {
  for (const candidate of text.match(/https:\/\/[^\s<>"\x1b]+/g) ?? []) {
    try {
      const url = new URL(candidate)
      if (['claude.ai', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname)
          && url.pathname.includes('/oauth/authorize') && url.searchParams.has('client_id')) return url.href
    } catch { /* Partial output, wait for the complete line. */ }
  }
  return null
}

/** Reuse the installed isolated Claude login helper; never rewrite the everyday login. */
export async function repairClaudeLogin(email, { onLink, helper = CLAUDE_REPAIR_HELPER, storePath = STORE, spawnChild = spawn, now = Date.now } = {}) {
  const startedAt = now()
  if (!existsSync(helper)) throw new Error('Install the Claude sign-in helper on this machine first.')
  let tail = '', lastUrl = null, report = Promise.resolve()
  const code = await new Promise((resolve, reject) => {
    const child = spawnChild(process.execPath, [helper, '--add', email], { stdio: ['ignore', 'pipe', 'pipe'] })
    const receive = chunk => {
      tail = (tail + chunk.toString()).slice(-16384)
      const boundary = tail.lastIndexOf('\n')
      if (boundary < 0) return
      const url = claudeSignInUrl(tail.slice(0, boundary))
      tail = tail.slice(boundary + 1)
      if (url && url !== lastUrl) { lastUrl = url; report = report.then(() => onLink?.(email, url, 'claude')).catch(() => {}) }
    }
    child.stdout.on('data', receive); child.stderr.on('data', receive)
    // The installed helper owns its four-minute login timeout and child cleanup.
    child.once('error', reject)
    child.once('close', resolve)
  })
  await report
  if (code !== 0) throw new Error('Claude sign-in did not complete. Try again and finish it in the browser.')
  const store = JSON.parse(await readFile(storePath, 'utf8'))
  const account = store.accounts?.find(entry => entry.email?.toLowerCase() === email.toLowerCase())
  if (!account?.oauth?.accessToken || Date.parse(account.updated_at ?? '') < startedAt || !Number.isFinite(Date.parse(account.updated_at ?? ''))) {
    return { email, provider: 'claude', outcome: 'mismatch', detail: 'That sign-in did not update this Claude account. Sign in with the email shown on this row.' }
  }
  return { email, provider: 'claude', outcome: 'signed-in' }
}
