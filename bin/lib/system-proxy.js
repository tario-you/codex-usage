import { execFileSync } from 'node:child_process'

/**
 * The Mac's system proxy for the long-running agents (her-team#12378, under
 * the system-proxy cause her-team#580). Abroad, a VPN's local proxy (Astrill's
 * OpenWeb) is the route macOS lists under Network > Proxies, and every browser
 * and app takes it. Node's fetch never reads it: it goes out on the local
 * network, where Anthropic answers 403 "Request not allowed" and OpenAI and
 * vercel.app never connect. On 10-13 every hosted sync stopped that way for
 * 29 hours, and a launchd environment set later never reaches an agent
 * launchd started before it (boot started them at 05:35, the route came at
 * 05:39), nor follows the VPN dropping and coming back.
 *
 * So each agent follows the route itself: at start and between passes it
 * compares the Mac's route with the one it runs on and, when they differ,
 * runs itself again in place (same process id) with Node's env proxy on, or
 * off once the proxy is gone. A proxy its caller set by hand is left alone.
 */

const MARK = 'CODEX_USAGE_ROUTE'
const QUIET = '--disable-warning=UNDICI-EHPA'
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']
const LOOPBACK = ['localhost', '127.0.0.1', '::1', '.local']

/** `scutil --proxy` as { proxy: 'http://host:port' or '', noProxy }. */
export function parseScutilProxy(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim())
  const field = (key) => {
    const line = lines.find((entry) => entry.startsWith(`${key} : `))
    return line ? line.slice(key.length + 3).trim() : ''
  }
  const proxyFor = (kind) =>
    field(`${kind}Enable`) === '1' && field(`${kind}Proxy`) && field(`${kind}Port`)
      ? `http://${field(`${kind}Proxy`)}:${field(`${kind}Port`)}`
      : ''
  const exceptions = []
  const start = lines.findIndex((line) => line.startsWith('ExceptionsList : '))
  if (start !== -1) {
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith('}')) break
      const at = line.indexOf(' : ')
      if (at !== -1) exceptions.push(line.slice(at + 3).trim().replace(/^\*\./, '.'))
    }
  }
  return {
    proxy: proxyFor('HTTPS') || proxyFor('HTTP'),
    noProxy: [...new Set([...LOOPBACK, ...exceptions])].join(','),
  }
}

/** The Mac's route now, or null where there is none to read (not a Mac, scutil failed). */
export function readMacRoute({ exec = execFileSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return null
  try {
    return parseScutilProxy(exec('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }))
  } catch {
    return null
  }
}

const routeKey = (route) => (route.proxy ? `${route.proxy} ${route.noProxy}` : 'direct')

/**
 * The environment to run again with, or null while this process already takes
 * the Mac's route. A process started with exactly the Mac's proxy (her-team's
 * launchd sync) adopts it in place; one started with another proxy, set by
 * hand, keeps it.
 */
export function routeChange(env, route) {
  if (!route) return null
  const want = routeKey(route)
  if (env[MARK] === undefined) {
    const own = env.HTTPS_PROXY || env.https_proxy
    if (own) {
      if (own !== route.proxy || env.NODE_USE_ENV_PROXY !== '1') return null
      env[MARK] = want
      return null
    }
    if (!route.proxy) return null
  }
  if ((env[MARK] ?? 'direct') === want) return null
  const next = { ...env }
  for (const key of PROXY_KEYS) delete next[key]
  if (route.proxy) {
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) next[key] = route.proxy
    next.NO_PROXY = next.no_proxy = route.noProxy
    next.NODE_USE_ENV_PROXY = '1'
  }
  next[MARK] = want
  return next
}

/**
 * Run this process again in place on the Mac's route when it changed. `before`
 * stops what the old image holds (a child process) first. Returns false when
 * nothing changed or this Node cannot re-run in place; otherwise never returns.
 */
export async function followSystemProxy({ before, env = process.env, route = readMacRoute(), execve = process.execve } = {}) {
  const next = routeChange(env, route)
  if (!next || typeof execve !== 'function') return false
  console.error(`Network route is now ${route.proxy || 'direct'} (the Mac's system proxy); restarting on it.`)
  if (before) await before()
  // Node's env proxy is experimental and warns on every start; one warning, silenced, as her-team's system-proxy.sh does.
  const quiet = route.proxy && !process.execArgv.includes(QUIET) ? [QUIET] : []
  execve.call(process, process.execPath, [process.execPath, ...quiet, ...process.execArgv, ...process.argv.slice(1)], next)
  return true
}
