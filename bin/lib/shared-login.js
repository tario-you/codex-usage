import { existsSync } from 'node:fs'
import { copyFile, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  applyAuthFileToStoreAccount,
  backupFileOnce,
  buildAuthFileFromStoreAccount,
  buildRecipientAuthFile,
  describeSharedLogin,
  findSwitcherStoreAccount,
  fingerprintSharedLogin,
  readJsonFile,
  resolveAuthFilePath,
  resolveDefaultSwitcherStorePath,
  validateSharedLoginFile,
  writeJsonFilePrivately,
} from './login-file.js'

export const SHARED_LOGIN_CONFIG_FILE_NAME = 'codex-usage-shared-login.json'
const DEFAULT_POLL_MS = 60_000
const NPX_COMMAND = 'npx codex-usage-dashboard@latest'

export const sharedLoginUsageLines = [
  '  codex-usage publish-login [--email <email>] [--store <accounts.json>] [--auth-file <auth.json>] [--codex-home <path>]',
  '  codex-usage publish-login --all [--store <accounts.json>] [--codex-home <path>]',
  '  codex-usage unpublish-login [--email <email>] [--codex-home <path>]',
  '  codex-usage use <login-url> [--watch] [--label <name>] [--codex-home <path>]',
  '  codex-usage use [--watch] [--codex-home <path>]',
  '  codex-usage use --restore [--codex-home <path>]',
]

// ---------------------------------------------------------------------------
// Owner side: publish a login, keep it fresh from `sync`, stop sharing.
// ---------------------------------------------------------------------------

export async function runPublishLoginCommand({
  args,
  codexHome,
  config,
  readSnapshot,
  writeConfig,
}) {
  const source = await resolvePublishSource(args, codexHome)
  const { identity, payload } = await publishLoginFromSource({ args, config, readSnapshot, source })
  await writeConfig(config)

  console.log(
    `Published Codex login for ${identity.email}${identity.planType ? ` (${identity.planType})` : ''}.`,
  )
  console.log(`Source: ${describeSource(source)}`)
  printPublishNextSteps(payload.shareUrl ?? resolveDashboardOrigin(config))
}

/** Publish every ChatGPT account in a Codex switcher store. */
export async function runPublishAllLoginsCommand({ args, codexHome, config, writeConfig }) {
  const storePath = args.options.store
    ? path.resolve(expandHome(args.options.store))
    : resolveDefaultSwitcherStorePath()
  const store = await readJsonFile(storePath)
  const accounts = Array.isArray(store?.accounts) ? store.accounts : []

  if (accounts.length === 0) {
    throw new Error(`No accounts found in the switcher store at ${storePath}.`)
  }

  let published = 0
  for (const account of accounts) {
    const email = typeof account?.email === 'string' ? account.email.toLowerCase() : null
    if (!email) {
      continue
    }

    try {
      const { identity } = await publishLoginFromSource({
        args,
        config,
        readSnapshot: null,
        source: { codexHome, email, kind: 'switcher', path: storePath },
      })
      published += 1
      console.log(`Published ${identity.email}${identity.planType ? ` (${identity.planType})` : ''}.`)
    } catch (error) {
      console.error(`Skipped ${email}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await writeConfig(config)
  console.log(`Published ${published} of ${accounts.length} logins from ${storePath}.`)
  printPublishNextSteps(resolveDashboardOrigin(config))
}

function printPublishNextSteps(shareUrl) {
  console.log(
    `Next: open ${shareUrl} and use "Share Codex login" to create a login command for someone. A pool command switches them across every published plan automatically.`,
  )
  console.log(
    `Keep \`${NPX_COMMAND} sync --watch\` running on this machine so recipients follow these accounts' token refreshes.`,
  )
}

async function publishLoginFromSource({ args, config, readSnapshot, source }) {
  const authFile = await readLoginFromSource(source)
  const identity = describeSharedLogin(authFile)

  if (source.email && source.email.toLowerCase() !== identity.email) {
    throw new Error(
      `${describeSource(source)} holds ${identity.email}, not ${source.email}.`,
    )
  }

  const snapshot = source.kind === 'codex-home' && readSnapshot ? await readSnapshot() : null
  const origin = resolveDashboardOrigin(config)
  const payload = await postJson(new URL('/api/login/publish', origin), {
    accountState: snapshot?.accountState,
    authFile,
    device: buildRecipientDevice(args, config.label),
    deviceToken: config.deviceToken,
    rateLimits: snapshot?.rateLimits,
  }, 'Unable to publish this login.')

  if (payload.outcome === 'pull' && payload.authFile) {
    await writeLoginToSource(source, payload.authFile)
    console.log(
      `The dashboard already held a newer login for ${identity.email}; updated ${describeSource(source)} to match.`,
    )
  }

  const entries = Array.isArray(config.publishedLogins) ? config.publishedLogins : []
  config.publishedLogins = [
    ...entries.filter((entry) => entry?.email !== identity.email),
    {
      email: identity.email,
      fingerprint: payload.fingerprint ?? fingerprintSharedLogin(authFile),
      source,
    },
  ]

  return { identity, payload }
}

export async function runUnpublishLoginCommand({ args, codexHome, config, writeConfig }) {
  const email = (args.options.email ?? (await readActiveLoginEmail(codexHome)))?.toLowerCase()
  if (!email) {
    throw new Error('Pass --email <email>, or log Codex into the account you want to stop sharing.')
  }

  const origin = resolveDashboardOrigin(config)
  await postJson(new URL('/api/login/unpublish', origin), {
    deviceToken: config.deviceToken,
    email,
  }, 'Unable to stop sharing this login.')

  config.publishedLogins = (config.publishedLogins ?? []).filter(
    (entry) => entry?.email !== email,
  )
  await writeConfig(config)
  console.log(`Stopped sharing the Codex login for ${email}. Every login command for it is revoked.`)
}

/**
 * Runs inside every usage sync. For each published login, compare the local
 * source with the dashboard copy and move the newest token generation in
 * whichever direction it needs to go. Returns true when the config changed.
 */
export async function reconcilePublishedLogins({ config, log = console.error }) {
  const entries = Array.isArray(config.publishedLogins) ? config.publishedLogins : []
  if (entries.length === 0) {
    return false
  }

  const origin = resolveDashboardOrigin(config)
  const keep = []
  let changed = false

  for (const entry of entries) {
    try {
      const authFile = await readLoginFromSource(entry.source)
      const identity = describeSharedLogin(authFile)

      if (identity.email !== entry.email) {
        keep.push(entry)
        continue
      }

      const fingerprint = fingerprintSharedLogin(authFile)
      const payload = await postJson(new URL('/api/login/sync', origin), {
        authFile: fingerprint === entry.fingerprint ? undefined : authFile,
        deviceToken: config.deviceToken,
        email: entry.email,
        fingerprint,
      }, `Unable to sync the shared login for ${entry.email}.`)

      if (payload.outcome === 'pull' && payload.authFile) {
        await writeLoginToSource(entry.source, payload.authFile)
        log(`[shared login] ${entry.email}: pulled a newer login into ${describeSource(entry.source)}.`)
      } else if (payload.outcome === 'stored') {
        log(`[shared login] ${entry.email}: pushed a newer login to the dashboard.`)
      }

      if (payload.fingerprint && payload.fingerprint !== entry.fingerprint) {
        changed = true
      }
      keep.push({ ...entry, fingerprint: payload.fingerprint ?? fingerprint })
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        log(`[shared login] ${entry.email} is no longer shared on the dashboard; dropping it.`)
        changed = true
        continue
      }

      log(`[shared login] ${entry.email}: ${error instanceof Error ? error.message : String(error)}`)
      keep.push(entry)
    }
  }

  config.publishedLogins = keep
  return changed
}

async function resolvePublishSource(args, codexHome) {
  const authFilePath = args.options['auth-file']
  const storePath = args.options.store
  const email = args.options.email?.toLowerCase() ?? null

  if (authFilePath) {
    return { email, kind: 'auth-file', path: path.resolve(expandHome(authFilePath)) }
  }

  if (storePath) {
    if (!email) {
      throw new Error('Pass --email <email> to choose an account from the switcher store.')
    }
    return { email, kind: 'store', path: path.resolve(expandHome(storePath)) }
  }

  if (email) {
    const defaultStore = resolveDefaultSwitcherStorePath()
    if (existsSync(defaultStore)) {
      return { codexHome, email, kind: 'switcher', path: defaultStore }
    }

    const activeEmail = await readActiveLoginEmail(codexHome)
    if (activeEmail === email) {
      return { email, kind: 'codex-home', path: codexHome }
    }

    throw new Error(
      `Codex is logged in as ${activeEmail ?? 'nobody'} here, and no switcher store exists at ${defaultStore}. Log in as ${email} or pass --auth-file.`,
    )
  }

  return { email: null, kind: 'codex-home', path: codexHome }
}

async function readLoginFromSource(source) {
  if (source.kind === 'switcher') {
    const candidates = []
    const active = await readJsonFile(resolveAuthFilePath(source.codexHome))
    if (active?.tokens?.access_token) {
      try {
        const file = validateSharedLoginFile(active)
        if (describeSharedLogin(file).email === source.email.toLowerCase()) {
          candidates.push(file)
        }
      } catch {
        // The active login is not a shareable ChatGPT login; use the store.
      }
    }

    try {
      candidates.push(await readLoginFromSource({ ...source, kind: 'store' }))
    } catch (error) {
      if (candidates.length === 0) {
        throw error
      }
    }

    return candidates.sort(
      (left, right) =>
        Date.parse(describeSharedLogin(right).issuedAt) -
        Date.parse(describeSharedLogin(left).issuedAt),
    )[0]
  }

  if (source.kind === 'store') {
    const store = await readJsonFile(source.path)
    if (!store) {
      throw new Error(`No switcher store found at ${source.path}.`)
    }

    const account = findSwitcherStoreAccount(store, source.email)
    if (!account) {
      throw new Error(`${source.email} is not in the switcher store at ${source.path}.`)
    }

    return buildAuthFileFromStoreAccount(account)
  }

  const filePath = source.kind === 'auth-file' ? source.path : resolveAuthFilePath(source.path)
  const file = await readJsonFile(filePath)
  if (!file) {
    throw new Error(`No Codex login found at ${filePath}. Run \`codex login\` first.`)
  }

  return validateSharedLoginFile(file, `The Codex auth file at ${filePath}`)
}

async function writeLoginToSource(source, authFile) {
  if (source.kind === 'switcher') {
    await writeLoginToSource({ ...source, kind: 'store' }, authFile)

    const activePath = resolveAuthFilePath(source.codexHome)
    const active = await readJsonFile(activePath)
    if (active?.tokens?.access_token) {
      try {
        if (describeSharedLogin(validateSharedLoginFile(active)).email === source.email.toLowerCase()) {
          await writeJsonFilePrivately(activePath, { ...active, ...authFile })
        }
      } catch {
        // Leave a foreign or unreadable active login alone.
      }
    }
    return
  }

  if (source.kind === 'store') {
    const store = await readJsonFile(source.path)
    const account = store ? findSwitcherStoreAccount(store, source.email) : null
    if (!account) {
      throw new Error(`${source.email} is not in the switcher store at ${source.path}.`)
    }

    applyAuthFileToStoreAccount(account, authFile)
    await writeJsonFilePrivately(source.path, store)
    return
  }

  const filePath = source.kind === 'auth-file' ? source.path : resolveAuthFilePath(source.path)
  await writeJsonFilePrivately(filePath, authFile)
}

async function readActiveLoginEmail(codexHome) {
  const file = await readJsonFile(resolveAuthFilePath(codexHome))
  if (!file?.tokens?.access_token) {
    return null
  }

  try {
    return describeSharedLogin(validateSharedLoginFile(file)).email
  } catch {
    return null
  }
}

function describeSource(source) {
  if (source.kind === 'switcher') {
    return `${source.path} (${source.email}), plus ${resolveAuthFilePath(source.codexHome)} while that account is active`
  }

  if (source.kind === 'store') {
    return `${source.path} (${source.email})`
  }

  return source.kind === 'auth-file' ? source.path : resolveAuthFilePath(source.path)
}

// ---------------------------------------------------------------------------
// Recipient side: install a shared login, keep it fresh, restore the old one.
// ---------------------------------------------------------------------------

export async function runUseCommand({ args, codexHome, rateLimitReader = null }) {
  if (args.options.restore) {
    await restoreSharedLogin(codexHome)
    return
  }

  const claimUrl = args.positionals[0]
  let config = await readSharedLoginConfig(codexHome)

  try {
    if (claimUrl) {
      config = await installSharedLogin({ args, claimUrl, codexHome })
    } else if (!config) {
      throw new Error(
        `No shared login is installed here. Run \`${NPX_COMMAND} use "<login-url>"\` with a login command from the dashboard.`,
      )
    } else {
      const result = await syncSharedLoginOnce({ codexHome, config, rateLimitReader })
      reportSyncResult(result, config)
      if (result.stopped) {
        return
      }
    }

    if (args.options.watch) {
      await watchSharedLogin({ codexHome, config, rateLimitReader })
    }
  } finally {
    await rateLimitReader?.close?.()
  }
}

async function installSharedLogin({ args, claimUrl, codexHome }) {
  const payload = await postJson(claimUrl, {
    device: buildRecipientDevice(args),
  }, 'Unable to claim this login.')

  validateSharedLoginFile(payload.authFile, 'The shared login')
  const authPath = resolveAuthFilePath(codexHome)
  const backupPath = await backupFileOnce(authPath)
  await writeJsonFilePrivately(authPath, buildRecipientAuthFile(payload.authFile))

  const config = {
    accessToken: payload.accessToken,
    account: payload.account,
    backupPath,
    codexHome,
    dashboardOrigin: payload.dashboardOrigin ?? new URL(claimUrl).origin,
    fingerprint: payload.fingerprint,
    installedAt: new Date().toISOString(),
    issuedAt: payload.issuedAt,
    pollMs: payload.pollMs ?? DEFAULT_POLL_MS,
    syncUrl: payload.syncUrl ?? new URL('/api/login/sync', claimUrl).toString(),
  }
  await writeSharedLoginConfig(codexHome, config)

  const plan = payload.account?.planType ? ` (${payload.account.planType})` : ''
  console.log(`Installed the shared Codex login for ${payload.account?.email ?? 'the shared account'}${plan}.`)
  if (payload.scope === 'pool') {
    console.log('This is a pool login: when this plan runs out, use --watch moves you to the next usable one.')
  }
  console.log(`Auth file: ${authPath}`)
  if (backupPath) {
    console.log(`Your previous login is saved at ${backupPath}.`)
  }
  console.log('Restart the Codex app or start a new `codex` session so it picks up the new login.')
  console.log(
    `Keep this running so it moves you to the next usable plan when this one runs out: ${NPX_COMMAND} use --watch`,
  )
  console.log(`Switch back: ${NPX_COMMAND} use --restore`)

  return config
}

export async function syncSharedLoginOnce({ codexHome, config, rateLimitReader = null }) {
  const authPath = resolveAuthFilePath(codexHome)
  const local = await readJsonFile(authPath)
  let localFile = null

  if (local) {
    try {
      localFile = validateSharedLoginFile(local, 'The local Codex auth file')
    } catch {
      return { outcome: 'foreign', reason: 'Codex here is no longer using a ChatGPT login.', stopped: true }
    }

    const localEmail = describeSharedLogin(localFile).email
    if (config.account?.email && localEmail !== config.account.email.toLowerCase()) {
      return {
        outcome: 'foreign',
        reason: `Codex here is now logged in as ${localEmail}. Leaving that login alone.`,
        stopped: true,
      }
    }
  }

  const fingerprint = localFile ? fingerprintSharedLogin(localFile) : 'missing'
  const rateLimits = localFile && rateLimitReader
    ? await rateLimitReader.read().catch(() => null)
    : null
  let payload

  try {
    payload = await postJson(config.syncUrl, {
      accessToken: config.accessToken,
      authFile: localFile && fingerprint !== config.fingerprint ? localFile : undefined,
      email: localFile ? describeSharedLogin(localFile).email : undefined,
      fingerprint,
      rateLimits: rateLimits ?? undefined,
    }, 'Unable to sync the shared login.')
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 410)) {
      const { restored } = await restoreSharedLogin(codexHome, { quiet: true })
      return { outcome: 'revoked', reason: error.message, restored, stopped: true }
    }

    throw error
  }

  if ((payload.outcome === 'pull' || payload.outcome === 'switch') && payload.authFile) {
    await writeJsonFilePrivately(authPath, buildRecipientAuthFile(payload.authFile))
  }

  if (payload.outcome === 'switch') {
    config.account = payload.account ?? config.account
    await rateLimitReader?.reset?.()
  }

  config.fingerprint = payload.fingerprint ?? fingerprint
  config.issuedAt = payload.issuedAt ?? config.issuedAt
  config.lastSyncedAt = new Date().toISOString()
  await writeSharedLoginConfig(codexHome, config)

  return { account: payload.account, outcome: payload.outcome, pool: payload.pool ?? null, stopped: false }
}

async function watchSharedLogin({ codexHome, config, rateLimitReader = null }) {
  const pollMs = config.pollMs ?? DEFAULT_POLL_MS
  console.log(`Watching the shared login every ${Math.round(pollMs / 1000)}s. Press Ctrl+C to stop.`)

  let running = false
  let stopped = false
  const tick = async () => {
    if (running || stopped) {
      return
    }

    running = true
    try {
      const result = await syncSharedLoginOnce({ codexHome, config, rateLimitReader })
      if (result.outcome === 'switch') {
        console.log(
          `[${new Date().toLocaleTimeString()}] Switched to ${result.account?.email ?? 'the next plan'}${result.account?.planType ? ` (${result.account.planType})` : ''}. Restart Codex if it is open.`,
        )
      } else if (result.pool?.reason === 'exhausted' && result.pool.nextAvailableAt) {
        console.log(
          `[${new Date().toLocaleTimeString()}] Every shared plan is used up. Next reset ${new Date(result.pool.nextAvailableAt).toLocaleString()}.`,
        )
      } else if (result.outcome === 'pull') {
        console.log(`[${new Date().toLocaleTimeString()}] Installed a newer login generation.`)
      } else if (result.outcome === 'stored') {
        console.log(`[${new Date().toLocaleTimeString()}] Sent this machine's newer login to the dashboard.`)
      }

      if (result.stopped) {
        stopped = true
        reportSyncResult(result, config)
        clearInterval(interval)
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
    } finally {
      running = false
    }
  }

  const interval = setInterval(() => {
    void tick()
  }, pollMs)

  await new Promise((resolve) => {
    const finish = () => {
      stopped = true
      clearInterval(interval)
      resolve()
    }
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
    const poll = setInterval(() => {
      if (stopped) {
        clearInterval(poll)
        resolve()
      }
    }, 500)
  })
}

export async function restoreSharedLogin(codexHome, { quiet = false } = {}) {
  const config = await readSharedLoginConfig(codexHome)
  const authPath = resolveAuthFilePath(codexHome)
  const backupPath = config?.backupPath ?? `${authPath}.before-shared-login`
  let restored = false

  if (existsSync(backupPath)) {
    await copyFile(backupPath, authPath)
    await unlink(backupPath)
    restored = true
    if (!quiet) {
      console.log(`Restored your previous Codex login from ${backupPath}.`)
    }
  } else if (existsSync(authPath)) {
    await unlink(authPath)
    if (!quiet) {
      console.log('Removed the shared login. Run `codex login` to sign in with your own account.')
    }
  }

  const configPath = resolveSharedLoginConfigPath(codexHome)
  if (existsSync(configPath)) {
    await unlink(configPath)
  }

  if (!quiet) {
    console.log('Restart the Codex app or start a new `codex` session to apply it.')
  }

  return { restored }
}

function reportSyncResult(result, config) {
  const email = config.account?.email ?? 'the shared account'

  if (result.outcome === 'revoked') {
    console.log(`The shared login for ${email} is no longer available (${result.reason}).`)
    console.log(
      result.restored
        ? 'Your previous Codex login was restored. Restart Codex to apply it.'
        : 'The shared login was removed. Run `codex login` to sign in with your own account.',
    )
  } else if (result.outcome === 'foreign') {
    console.log(result.reason)
  } else if (result.outcome === 'switch') {
    console.log(
      `Switched to ${result.account?.email ?? 'the next plan'}${result.account?.planType ? ` (${result.account.planType})` : ''}. Restart Codex if it is open.`,
    )
  } else if (result.pool?.reason === 'exhausted' && result.pool.nextAvailableAt) {
    console.log(
      `Every shared plan is used up right now. Next reset ${new Date(result.pool.nextAvailableAt).toLocaleString()}.`,
    )
  } else if (result.outcome === 'pull') {
    console.log(`Installed a newer login generation for ${email}. Restart Codex if it complains about the token.`)
  } else if (result.outcome === 'stored') {
    console.log(`This machine refreshed the login for ${email}; sent it to the dashboard.`)
  } else {
    console.log(`The shared login for ${email} is current.`)
  }
}

export function resolveSharedLoginConfigPath(codexHome) {
  return path.join(codexHome, SHARED_LOGIN_CONFIG_FILE_NAME)
}

export async function readSharedLoginConfig(codexHome) {
  return readJsonFile(resolveSharedLoginConfigPath(codexHome))
}

async function writeSharedLoginConfig(codexHome, config) {
  await writeJsonFilePrivately(resolveSharedLoginConfigPath(codexHome), config)
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

async function postJson(url, body, fallbackMessage) {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const text = (await response.text().catch(() => '')).trim()
  let data = {}

  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = {}
  }

  if (!response.ok) {
    const detail =
      typeof data?.error === 'string' && data.error.trim()
        ? data.error.trim()
        : `HTTP ${response.status}`
    throw new HttpError(`${fallbackMessage} ${detail}`, response.status)
  }

  return data
}

function buildRecipientDevice(args, fallbackLabel) {
  return {
    label: args.options.label ?? fallbackLabel ?? os.hostname(),
    machineName: os.hostname(),
  }
}

function resolveDashboardOrigin(config) {
  const origin = config.dashboardOrigin ?? (config.syncUrl ? new URL(config.syncUrl).origin : null)
  if (!origin) {
    throw new Error('The pairing config has no dashboard origin. Pair this machine again.')
  }

  return origin
}

function expandHome(value) {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
}
