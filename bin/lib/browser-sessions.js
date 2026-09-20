import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, lstat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dashboardRequest } from './dashboard-request.js'

export const BROWSER_SESSION_ROOT = path.join(os.homedir(), '.local/share/codex-usage/browser-sessions')
const PROVIDER_URLS = { codex: 'https://chatgpt.com/', claude: 'https://claude.ai/' }
const CHROME_APP = '/Applications/Google Chrome.app'

export function browserSessionTarget(provider, email, root = BROWSER_SESSION_ROOT) {
  if (!Object.hasOwn(PROVIDER_URLS, provider)) throw new Error('Unsupported provider.')
  if (typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid account email.')
  const key = createHash('sha256').update(`${provider}\0${email.trim().toLowerCase()}`).digest('hex')
  return { url: PROVIDER_URLS[provider], directory: path.join(root, key) }
}

export function chromeLaunchArgs(target) {
  return ['-n', '-a', CHROME_APP, '--args', `--user-data-dir=${target.directory}`, '--new-window', target.url]
}

/** Only a saved, isolated profile is opened. No CLI tokens, cookies, or passwords are transferred. */
export async function openBrowserSession(provider, email, { root = BROWSER_SESSION_ROOT, launch = launchChrome } = {}) {
  const target = browserSessionTarget(provider, email, root)
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Browser session directory must not be a link.')
  await mkdir(target.directory, { recursive: true, mode: 0o700 })
  if ((await lstat(target.directory)).isSymbolicLink()) throw new Error('Browser session directory must not be a link.')
  await launch(chromeLaunchArgs(target))
  return target
}

function launchChrome(args) {
  if (process.platform !== 'darwin' || !existsSync(CHROME_APP)) throw new Error('This helper requires Google Chrome on macOS.')
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Chrome could not be opened.')))
  })
}

export async function runBrowserPass(config, { fetcher = fetch, open = openBrowserSession, now = () => Date.now() } = {}) {
  const site = new URL(config.dashboardOrigin ?? config.syncUrl)
  if (site.protocol !== 'https:' && !(site.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(site.hostname))) throw new Error('Invalid dashboard origin.')
  const call = async (route, body) => {
    const response = await fetcher(new URL(`/api/login/browser${route}`, site), dashboardRequest({ deviceToken: config.deviceToken, ...body }, { timeoutMs: 10_000 }))
    if (!response.ok) throw new Error('Browser helper request failed.')
    return response.json()
  }
  const { pending } = await call('/poll', {})
  if (!pending) return false
  if (typeof pending.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(pending.id)) throw new Error('Invalid browser request.')
  const expires = Date.parse(pending.expires_at)
  let outcome = 'failed'
  const receivedAt = now()
  if (Number.isFinite(expires) && expires > receivedAt && expires - receivedAt <= 120_000) {
    try {
      browserSessionTarget(pending.provider, pending.email)
      await open(pending.provider, pending.email)
      outcome = 'opened'
    } catch { /* Report failure without exposing paths, credentials, or account data. */ }
  }
  await call('/done', { requestId: pending.id, outcome })
  return outcome === 'opened'
}

export async function runBrowserAgent(config) {
  if (!config?.deviceToken || !config?.syncUrl) throw new Error('Pair this machine with the dashboard first.')
  if (process.platform !== 'darwin' || !existsSync(CHROME_APP)) throw new Error('This helper requires Google Chrome on macOS.')
  console.log('Browser helper ready. Account clicks open separate Chrome sessions; sign in once per account.')
  for (;;) {
    try { await runBrowserPass(config) } catch { console.error('Browser helper could not reach the dashboard; retrying.') }
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
}
