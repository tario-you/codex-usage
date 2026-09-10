#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { selectCodexExecutable } from './lib/codex-runtime.js'
import {
  reconcilePublishedLogins,
  runPublishAllLoginsCommand,
  runPublishLoginCommand,
  runUnpublishLoginCommand,
  runUseCommand,
  sharedLoginUsageLines,
} from './lib/shared-login.js'
import { uploadSwitchEvents } from './lib/switch-events.js'
import {
  DEFAULT_SYNC_ALL_INTERVAL_SECONDS,
  MIN_SYNC_ALL_INTERVAL_SECONDS,
  readStore,
  resolveStorePath,
  syncAllOnce,
  upsertStoreAccount,
  writeStore,
} from './lib/sync-all.js'
import { readJsonFile, resolveAuthFilePath } from './lib/login-file.js'

const DEFAULT_POLL_MS = 60_000
const CONFIG_FILE_NAME = 'codex-usage-sync.json'
const NPX_COMMAND = 'npx codex-usage-dashboard@latest'

let codexAppServerSupportPromise = null

class StdioCodexClient {
  constructor({ codexHome }) {
    this.codexHome = codexHome
    this.child = null
    this.buffer = ''
    this.isClosing = false
    this.lastStderrMessage = ''
    this.pending = new Map()
    this.requestId = 0
    this.notificationHandler = null
  }

  async connect() {
    if (this.child) {
      return
    }

    this.buffer = ''
    this.lastStderrMessage = ''
    this.child = await this.spawnAppServer()

    await this.request('initialize', {
      capabilities: {},
      clientInfo: {
        name: 'codex_usage_sync',
        title: 'Codex Usage Sync',
        version: '0.1.0',
      },
    })
    this.notify('initialized', {})
  }

  async close() {
    if (!this.child) {
      return
    }

    const child = this.child
    this.child = null
    this.isClosing = true
    child.kill('SIGTERM')

    this.rejectPending(new Error('Codex app-server closed.'))
  }

  onNotification(handler) {
    this.notificationHandler = handler
  }

  request(method, params) {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error('Codex app-server is not connected.')
    }

    const id = ++this.requestId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve })

      this.child.stdin.write(
        `${JSON.stringify({
          id,
          jsonrpc: '2.0',
          method,
          ...(params ? { params } : {}),
        })}\n`,
        (error) => {
          if (!error) {
            return
          }

          this.pending.delete(id)
          reject(error)
        },
      )
    })
  }

  notify(method, params) {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      return
    }

    this.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method,
        ...(params ? { params } : {}),
      })}\n`,
    )
  }

  consumeStdout(chunk) {
    this.buffer += chunk

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }

      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)

      if (!line) {
        continue
      }

      let message

      try {
        message = JSON.parse(line)
      } catch {
        console.error(`[codex] ${line}`)
        continue
      }

      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (!pending) {
          continue
        }

        this.pending.delete(message.id)

        if (message.error) {
          pending.reject(
            new Error(message.error.message ?? 'Codex app-server error.'),
          )
          continue
        }

        pending.resolve(message.result)
        continue
      }

      if (message.method && this.notificationHandler) {
        this.notificationHandler(message.method)
      }
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }

    this.pending.clear()
  }

  async spawnAppServer() {
    const codexExecutable = await ensureCodexAppServerSupport()

    return new Promise((resolve, reject) => {
      const child = spawn(
        codexExecutable.command,
        [...codexExecutable.argsPrefix, 'app-server', '--listen', 'stdio://'],
        {
          env: {
            ...process.env,
            ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        this.consumeStdout(chunk)
      })

      child.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim()
        if (!message) {
          return
        }

        const lines = message.split(/\r?\n/)
        this.lastStderrMessage = lines[lines.length - 1] ?? message
        console.error(`[codex] ${message}`)
      })

      child.once('error', (error) => {
        reject(
          new Error(
            error.code === 'ENOENT'
              ? 'Codex CLI is not available. Reinstall `codex-usage-dashboard` or install it globally with `npm install -g @openai/codex`.'
              : error.message,
          ),
        )
      })

      child.once('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null
        }

        const expectedShutdown = this.isClosing
        this.isClosing = false

        if (expectedShutdown) {
          return
        }

        const error = buildCodexAppServerExitError(
          code,
          signal,
          this.lastStderrMessage,
        )
        this.rejectPending(error)
      })

      child.once('spawn', () => {
        resolve(child)
      })
    })
  }
}

async function main() {
  const [, , command, ...restArgs] = process.argv

  if (!command || command === '--help' || command === '-h') {
    printUsage()
    return
  }

  const args = parseArgs(restArgs)

  if (command === 'pair') {
    await runPairCommand(args)
    return
  }

  if (command === 'connect') {
    await runConnectCommand(args)
    return
  }

  if (command === 'sync') {
    await runSyncCommand(args)
    return
  }

  if (command === 'login') {
    await runLoginCommand(args)
    return
  }

  if (command === 'publish-login') {
    await runPublishLoginFromCli(args)
    return
  }

  if (command === 'unpublish-login') {
    await runUnpublishLoginFromCli(args)
    return
  }

  if (command === 'use') {
    const codexHome = resolveCodexHome(args.options['codex-home'])
    await runUseCommand({
      args,
      codexHome,
      rateLimitReader: createRateLimitReader(codexHome),
    })
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

async function runPairCommand(args) {
  const pairUrl = args.positionals[0]
  if (!pairUrl) {
    throw new Error('Pass the pairing URL from the website.')
  }

  const codexHome = resolveCodexHome(args.options['codex-home'])
  const client = new StdioCodexClient({ codexHome })

  try {
    await client.connect()
    const snapshot = await readSnapshot(client, true)
    const device = buildDevicePayload(args, codexHome)
    const response = await fetch(pairUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountState: snapshot.accountState,
        device,
        rateLimits: snapshot.rateLimits,
      }),
    })

    const payload = await parseResponseBody(response)
    if (!response.ok) {
      throw new Error(buildHttpErrorMessage(response, payload, 'Pairing failed.'))
    }

    const config = {
      authMode: 'website-paired',
      codexHome,
      deviceId: payload.data.deviceId,
      deviceToken: payload.data.deviceToken,
      dashboardOrigin: new URL(pairUrl).origin,
      label: device.label,
      pollMs: payload.data.pollMs ?? DEFAULT_POLL_MS,
      syncUrl: payload.data.syncUrl,
    }

    await writeConfig(codexHome, config)
    console.log('Pairing complete.')
    console.log(`Config saved to ${resolveConfigPath(codexHome)}`)
    console.log('')
    console.log('What this did: this machine now reports its own Codex usage to the dashboard.')
    console.log(
      'What it did not do: it did not sign this machine into anyone else\'s plan.',
    )
    console.log(
      '  To use someone else\'s plans, run the login command from their "Share Codex login" card:',
    )
    console.log(`  ${NPX_COMMAND} use "<login url>" --watch`)
    console.log('')
    console.log(`Next: keep \`${NPX_COMMAND} sync --watch\` running here for live updates.`)

    if (args.options.watch) {
      await runWatchLoop(client, config, args)
    }
  } finally {
    await client.close()
  }
}

async function runConnectCommand(args) {
  const codexHome = resolveCodexHome(args.options['codex-home'])
  const existingConfig = await readConfig(codexHome)
  const client = new StdioCodexClient({ codexHome })
  const siteOriginFromArgs = resolveSiteOrigin(args.options.site)

  try {
    await client.connect()

    if (existingConfig) {
      try {
        const dashboardUrl = await resolveExistingDashboardUrl(existingConfig, args)
        let dashboardOpenState = null

        if (dashboardUrl) {
          dashboardOpenState = await openDashboard(dashboardUrl)
        }

        await syncOnce(client, existingConfig, args)
        logDashboardOpenState(dashboardOpenState)

        if (args.options.watch) {
          await runWatchLoop(client, existingConfig, args)
        }

        return
      } catch (error) {
        if (!isRevokedDeviceError(error)) {
          throw error
        }

        const siteOrigin =
          siteOriginFromArgs ??
          existingConfig.dashboardOrigin ??
          deriveOriginFromUrl(existingConfig.syncUrl)

        if (!siteOrigin) {
          throw new Error(
            `This device was unlinked from the dashboard. Rerun \`${NPX_COMMAND} connect --site "<dashboard-url>"\` to create a new connection.`,
          )
        }

        console.log(
          'This device was unlinked from the dashboard. Creating a new connection...',
        )

        const refreshedConfig = await startConnectFlow(
          client,
          args,
          codexHome,
          siteOrigin,
        )

        if (args.options.watch) {
          await runWatchLoop(client, refreshedConfig, args)
        }

        return
      }
    }

    const siteOrigin = siteOriginFromArgs
    if (!siteOrigin) {
      throw new Error(
        'Pass --site <url> the first time you run connect, or set CODEX_USAGE_SITE_URL.',
      )
    }

    const config = await startConnectFlow(client, args, codexHome, siteOrigin)

    if (args.options.watch) {
      await runWatchLoop(client, config, args)
    }
  } finally {
    await client.close()
  }
}

async function startConnectFlow(client, args, codexHome, siteOrigin) {
  const snapshot = await readSnapshot(client, true)
  const device = buildDevicePayload(args, codexHome)
  const response = await fetch(new URL('/api/connect/start', siteOrigin), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      accountState: snapshot.accountState,
      device,
      rateLimits: snapshot.rateLimits,
    }),
  })

  const payload = await parseResponseBody(response)
  if (!response.ok) {
    throw new Error(
      buildHttpErrorMessage(response, payload, 'Unable to connect this machine.'),
    )
  }

  const config = {
    authMode: 'guest-link',
    codexHome,
    dashboardOrigin: siteOrigin,
    deviceId: payload.data.deviceId,
    deviceToken: payload.data.deviceToken,
    label: device.label,
    pollMs: payload.data.pollMs ?? DEFAULT_POLL_MS,
    syncUrl: payload.data.syncUrl,
  }

  await writeConfig(codexHome, config)
  const dashboardOpenState = await openDashboard(payload.data.dashboardUrl)
  logDashboardOpenState(dashboardOpenState)
  console.log(`Config saved to ${resolveConfigPath(codexHome)}`)
  console.log(
    `Next: rerun \`${NPX_COMMAND} connect --site "${siteOrigin}"\` to reopen this dashboard, or \`${NPX_COMMAND} sync --watch\` for live updates only.`,
  )

  return config
}

/**
 * Reads the shared account's live rate limits through codex app-server so a
 * pool recipient reports real usage. Every failure is treated as "no data".
 */
function createRateLimitReader(codexHome) {
  let client = null

  const close = async () => {
    if (client) {
      const current = client
      client = null
      await current.close()
    }
  }

  return {
    close,
    async read() {
      try {
        if (!client) {
          client = new StdioCodexClient({ codexHome })
          await client.connect()
        }

        const accountState = await client.request('account/read', {
          refreshToken: false,
        })
        if (!accountState.account) {
          return null
        }

        return await client.request('account/rateLimits/read')
      } catch {
        await close().catch(() => {})
        return null
      }
    },
    reset: close,
  }
}

async function runPublishLoginFromCli(args) {
  const codexHome = resolveCodexHome(args.options['codex-home'])
  const config = await requirePairingConfig(codexHome)

  if (args.options.all) {
    await runPublishAllLoginsCommand({
      args,
      codexHome,
      config,
      writeConfig: (nextConfig) => writeConfig(codexHome, nextConfig),
    })
    return
  }

  const usesActiveLogin = !args.options['auth-file'] && !args.options.store
  const client = usesActiveLogin ? new StdioCodexClient({ codexHome }) : null

  try {
    if (client) {
      await client.connect()
    }

    await runPublishLoginCommand({
      args,
      codexHome,
      config,
      readSnapshot: client ? () => readSnapshot(client, true) : null,
      writeConfig: (nextConfig) => writeConfig(codexHome, nextConfig),
    })
  } finally {
    if (client) {
      await client.close()
    }
  }
}

async function runUnpublishLoginFromCli(args) {
  const codexHome = resolveCodexHome(args.options['codex-home'])
  const config = await requirePairingConfig(codexHome)

  await runUnpublishLoginCommand({
    args,
    codexHome,
    config,
    writeConfig: (nextConfig) => writeConfig(codexHome, nextConfig),
  })
}

async function requirePairingConfig(codexHome) {
  const config = await readConfig(codexHome)
  if (!config) {
    throw new Error(
      'No pairing config found. Run `connect` or pair this machine from the website first.',
    )
  }

  return config
}

async function runSyncCommand(args) {
  const codexHome = resolveCodexHome(args.options['codex-home'])
  const config = await readConfig(codexHome)
  if (!config) {
    throw new Error(
      'No pairing config found. Run `connect` or pair this machine from the website first.',
    )
  }

  if (args.options.all) {
    await runSyncAllCommand(args, config, codexHome)
    return
  }

  const client = new StdioCodexClient({ codexHome })

  try {
    await client.connect()

    if (args.options.watch) {
      await runWatchLoop(client, config, args)
      return
    }

    await syncOnce(client, config, args)
    console.log('Sync complete.')
  } finally {
    await client.close()
  }
}

/**
 * Every saved account, one machine: read each login's usage from the usage
 * endpoint and report it under this machine's pairing. No Codex app-server is
 * involved, so it runs anywhere the store exists.
 */
async function runSyncAllCommand(args, config, codexHome) {
  const storePath = resolveStorePath(args.options.store)
  const device = buildDevicePayload(args, codexHome, config.label)

  const once = async () => {
    let activeAuthFile = null
    const authPath = resolveAuthFilePath(codexHome)
    if (existsSync(authPath)) {
      try {
        const file = await readJsonFile(authPath)
        if (file?.auth_mode === 'chatgpt' && file.tokens?.refresh_token) activeAuthFile = file
      } catch {
        activeAuthFile = null
      }
    }
    const summary = await syncAllOnce({ activeAuthFile, config, device, storePath })
    for (const email of summary.added) console.log(`Saved the login this machine is signed into: ${email}.`)
    for (const result of summary.results) {
      console.log(
        result.ok
          ? `  ${result.email}: ${result.usedPercent ?? '?'}% used${result.planType ? ` (${result.planType})` : ''}`
          : `  ${result.email}: skipped, ${result.reason}`,
      )
    }
    console.log(
      `[${new Date().toLocaleTimeString()}] Synced ${summary.synced} of ${summary.total} accounts from ${storePath}.`,
    )
    if (summary.total === 0) {
      console.log(`No saved accounts yet. Add one with: ${NPX_COMMAND} login add`)
    }
  }

  await once()
  if (!args.options.watch) return

  const requested = Number(args.options.every ?? DEFAULT_SYNC_ALL_INTERVAL_SECONDS)
  const everySeconds = Math.max(
    MIN_SYNC_ALL_INTERVAL_SECONDS,
    Number.isFinite(requested) ? requested : DEFAULT_SYNC_ALL_INTERVAL_SECONDS,
  )
  console.log(`Watching every ${everySeconds}s. Press Ctrl+C to stop.`)
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, everySeconds * 1000))
    try {
      await once()
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * login add signs one more Codex account in through a throwaway CODEX_HOME and
 * saves it into the store; login list and login remove manage the store.
 */
async function runLoginCommand(args) {
  const action = args.positionals[0]
  const storePath = resolveStorePath(args.options.store)

  if (action === 'list') {
    const store = await readStore(storePath)
    if (store.accounts.length === 0) {
      console.log(`No saved accounts in ${storePath}. Add one with: ${NPX_COMMAND} login add`)
      return
    }
    for (const account of store.accounts) {
      console.log(`  ${account.email ?? account.id}${account.plan_type ? ` (${account.plan_type})` : ''}`)
    }
    console.log(`${store.accounts.length} saved account(s) in ${storePath}.`)
    return
  }

  if (action === 'remove') {
    const email = args.options.email?.toLowerCase()
    if (!email) throw new Error('Pass --email for the account to forget.')
    const store = await readStore(storePath)
    const before = store.accounts.length
    store.accounts = store.accounts.filter((account) => account.email?.toLowerCase() !== email)
    if (store.accounts.length === before) throw new Error(`${email} is not in ${storePath}.`)
    await writeStore(storePath, store)
    console.log(`Forgot ${email}. ${store.accounts.length} saved account(s) left.`)
    return
  }

  if (action !== 'add') {
    throw new Error('Usage: login add | login list | login remove --email <email>')
  }

  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-login-'))
  const client = new StdioCodexClient({ codexHome: home })
  try {
    await client.connect()
    const completed = new Promise((resolve, reject) => {
      client.onNotification((method) => {
        if (method === 'account/login/completed') resolve()
      })
      const timer = setTimeout(
        () => reject(new Error('Sign-in timed out after 10 minutes. Run "login add" again.')),
        10 * 60 * 1000,
      )
      timer.unref?.()
    })
    const started = await client.request('account/login/start', { type: 'chatgpt' })
    if (!started?.authUrl) throw new Error('Codex did not return a sign-in link.')
    console.log('Sign in with the account you want to add. Finish in the browser, then come back here.')
    const opened = await openDashboard(started.authUrl)
    if (opened === 'browser') console.log(`If the browser did not open: ${started.authUrl}`)
    await completed

    const authPath = resolveAuthFilePath(home)
    if (!existsSync(authPath)) throw new Error('Sign-in did not complete; nothing was saved.')
    const authFile = await readJsonFile(authPath)
    const store = await readStore(storePath)
    const { account, created } = upsertStoreAccount(store, authFile)
    await writeStore(storePath, store)
    console.log(
      `${created ? 'Saved' : 'Updated'} ${account.email ?? account.id}. ${store.accounts.length} saved account(s) in ${storePath}.`,
    )
    console.log(`Next: ${NPX_COMMAND} sync --all --watch`)
  } finally {
    await client.close()
    await rm(home, { force: true, recursive: true })
  }
}

async function runWatchLoop(client, config, args) {
  let scheduledRefresh = null
  let isSyncing = false

  const run = async () => {
    if (isSyncing) {
      return
    }

    isSyncing = true

    try {
      await syncOnce(client, config, args)
      console.log(`[${new Date().toLocaleTimeString()}] Sync complete.`)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
    } finally {
      isSyncing = false
    }
  }

  client.onNotification((method) => {
    if (
      method !== 'account/login/completed' &&
      method !== 'account/rateLimits/updated' &&
      method !== 'account/updated'
    ) {
      return
    }

    if (scheduledRefresh) {
      clearTimeout(scheduledRefresh)
    }

    scheduledRefresh = setTimeout(() => {
      void run()
    }, 500)
  })

  await run()

  const interval = setInterval(() => {
    void run()
  }, config.pollMs ?? DEFAULT_POLL_MS)

  await waitForTermination(async () => {
    clearInterval(interval)

    if (scheduledRefresh) {
      clearTimeout(scheduledRefresh)
      scheduledRefresh = null
    }

    await client.close()
  })
}

async function syncOnce(client, config, args) {
  const snapshot = await readSnapshot(client, false)
  if (!snapshot) {
    await reconcilePublishedLoginsSafely(config, args)
    return
  }

  const response = await fetch(config.syncUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      accountState: snapshot.accountState,
      device: buildDevicePayload(args, config.codexHome, config.label),
      deviceToken: config.deviceToken,
      rateLimits: snapshot.rateLimits,
    }),
  })

  const payload = await parseResponseBody(response)
  if (!response.ok) {
    throw new Error(buildHttpErrorMessage(response, payload, 'Sync failed.'))
  }

  await reconcilePublishedLoginsSafely(config, args)
  await uploadSwitchEventsSafely(config, args)
}

async function uploadSwitchEventsSafely(config, args) {
  try {
    const result = await uploadSwitchEvents({ config })
    if (result.uploaded > 0 && result.uploadedAt !== config.switchEventsUploadedAt) {
      config.switchEventsUploadedAt = result.uploadedAt
      await writeConfig(
        config.codexHome ?? resolveCodexHome(args.options['codex-home']),
        config,
      )
    }
  } catch (error) {
    console.error(
      `[switch history] ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function reconcilePublishedLoginsSafely(config, args) {
  if (!Array.isArray(config.publishedLogins) || config.publishedLogins.length === 0) {
    return
  }

  try {
    const changed = await reconcilePublishedLogins({ config })
    if (changed) {
      await writeConfig(
        config.codexHome ?? resolveCodexHome(args.options['codex-home']),
        config,
      )
    }
  } catch (error) {
    console.error(
      `[shared login] ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function resolveExistingDashboardUrl(config, args) {
  if (config.authMode === 'guest-link') {
    const response = await fetch(new URL('/api/connect/open', config.syncUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deviceToken: config.deviceToken,
      }),
    })

    const payload = await parseResponseBody(response)
    if (!response.ok) {
      throw new Error(
        buildHttpErrorMessage(response, payload, 'Unable to open the dashboard.'),
      )
    }

    return payload.data.dashboardUrl ?? null
  }

  const siteOrigin =
    resolveSiteOrigin(args.options.site) ??
    config.dashboardOrigin ??
    new URL(config.syncUrl).origin

  return siteOrigin || null
}

async function readSnapshot(client, failWhenLoggedOut) {
  const accountState = await client.request('account/read', {
    refreshToken: false,
  })

  if (!accountState.account) {
    if (failWhenLoggedOut) {
      throw new Error(
        'No logged-in Codex account was found. Run `npx @openai/codex@latest login` (or `codex login` if installed globally) and try again.',
      )
    }

    console.log('No logged-in Codex account found yet. Waiting for login.')
    return null
  }

  const rateLimits = await client.request('account/rateLimits/read')
  // The login's earned reset credits ride the snapshot so the dashboard can show them.
  const credits = rateLimits?.rateLimitResetCredits
  if (rateLimits?.rateLimits && credits && typeof credits.availableCount === 'number') {
    rateLimits.rateLimits.resetCredits = { applicable: null, available: credits.availableCount }
  }
  return { accountState, rateLimits }
}

function buildDevicePayload(args, codexHome, fallbackLabel) {
  return {
    codexHome,
    label: args.options.label ?? fallbackLabel ?? os.hostname(),
    machineName: os.hostname(),
    metadata: {
      arch: process.arch,
      node: process.version,
      platform: process.platform,
    },
  }
}

async function openDashboard(url) {
  try {
    await openInBrowser(url)
    return 'browser'
  } catch {
    console.log(`Open this URL in your browser: ${url}`)
    return 'manual'
  }
}

function logDashboardOpenState(state) {
  if (state === 'browser') {
    console.log('Dashboard URL sent to your browser.')
    return
  }

  if (state === 'manual') {
    console.log('Dashboard URL ready.')
  }
}

function parseArgs(rawArgs) {
  const options = {}
  const positionals = []

  for (let index = 0; index < rawArgs.length; index += 1) {
    const value = rawArgs[index]

    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }

    const key = value.slice(2)

    if (key === 'watch' || key === 'restore' || key === 'all') {
      options[key] = true
      continue
    }

    const nextValue = rawArgs[index + 1]
    if (!nextValue || nextValue.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }

    options[key] = nextValue
    index += 1
  }

  return { options, positionals }
}

function resolveSiteOrigin(configuredValue) {
  const value = configuredValue ?? process.env.CODEX_USAGE_SITE_URL
  if (!value) {
    return null
  }

  return new URL(value).origin
}

function deriveOriginFromUrl(value) {
  if (typeof value !== 'string' || !value) {
    return null
  }

  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function resolveCodexHome(configuredValue) {
  const home = configuredValue ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')

  if (!home.startsWith('~/')) {
    return home
  }

  return path.join(os.homedir(), home.slice(2))
}

function resolveConfigPath(codexHome) {
  return path.join(codexHome, CONFIG_FILE_NAME)
}

function openInBrowser(url) {
  return new Promise((resolve, reject) => {
    const target =
      process.platform === 'darwin'
        ? { args: [url], command: 'open' }
        : process.platform === 'win32'
          ? { args: ['/c', 'start', '', url], command: 'cmd' }
          : { args: [url], command: 'xdg-open' }

    const child = spawn(target.command, target.args, {
      detached: true,
      stdio: 'ignore',
    })

    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function ensureCodexAppServerSupport() {
  if (!codexAppServerSupportPromise) {
    codexAppServerSupportPromise = selectCodexExecutable().catch(
      (error) => {
        codexAppServerSupportPromise = null
        throw error
      },
    )
  }

  return codexAppServerSupportPromise
}

function buildCodexAppServerExitError(code, signal, stderrMessage) {
  const exitDetail =
    typeof code === 'number'
      ? `exit code ${code}`
      : signal
        ? `signal ${signal}`
        : 'no exit code'

  const message = [`Codex app-server exited unexpectedly (${exitDetail}).`]
  if (stderrMessage) {
    message.push(stderrMessage)
  }

  return new Error(message.join(' '))
}

async function writeConfig(codexHome, config) {
  await mkdir(codexHome, { recursive: true })
  await writeFile(
    resolveConfigPath(codexHome),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  )
}

async function readConfig(codexHome) {
  const configPath = resolveConfigPath(codexHome)
  if (!existsSync(configPath)) {
    return null
  }

  const rawConfig = JSON.parse(await readFile(configPath, 'utf8'))
  const normalizedConfig = normalizeConfig(rawConfig)

  if (JSON.stringify(normalizedConfig) !== JSON.stringify(rawConfig)) {
    await writeConfig(codexHome, normalizedConfig)
  }

  return normalizedConfig
}

function normalizeConfig(config) {
  if (!config || typeof config !== 'object') {
    return config
  }

  const normalizedConfig = { ...config }

  if (
    !normalizedConfig.dashboardOrigin &&
    typeof normalizedConfig.syncUrl === 'string'
  ) {
    try {
      normalizedConfig.dashboardOrigin = new URL(
        normalizedConfig.syncUrl,
      ).origin
    } catch {
      // Leave the saved origin untouched when the sync URL is malformed.
    }
  }

  if (looksLikeLegacyGuestLinkConfig(config)) {
    normalizedConfig.authMode = 'guest-link'
  }

  return normalizedConfig
}

function looksLikeLegacyGuestLinkConfig(config) {
  return (
    !config.authMode &&
    !config.dashboardOrigin &&
    typeof config.deviceToken === 'string' &&
    config.deviceToken.length > 0 &&
    typeof config.syncUrl === 'string' &&
    config.syncUrl.length > 0
  )
}

async function parseResponseBody(response) {
  const text = (await response.text().catch(() => '')).trim()
  if (!text) {
    return { data: {}, text: '' }
  }

  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      return { data: parsed, text }
    }
  } catch {
    // Fall back to the raw text when the response body is not JSON.
  }

  return { data: {}, text }
}

function buildHttpErrorMessage(response, payload, fallbackMessage) {
  const bodyError =
    typeof payload.data?.error === 'string' && payload.data.error.trim()
      ? payload.data.error.trim()
      : null
  const plainText =
    payload.text && !looksLikeHtml(payload.text)
      ? payload.text.replace(/\s+/g, ' ').trim()
      : ''
  const statusLabel = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
  const vercelError = response.headers.get('x-vercel-error')
  const vercelId = response.headers.get('x-vercel-id')

  const detail = bodyError ?? truncateText(plainText, 240)
  let message = detail
    ? `${fallbackMessage} ${detail}`
    : `${fallbackMessage} HTTP ${statusLabel}.`

  if (!detail) {
    return appendHttpContext(message, vercelError, vercelId)
  }

  if (!bodyError) {
    message = `${message} (HTTP ${statusLabel})`
  }

  return appendHttpContext(message, vercelError, vercelId)
}

function isRevokedDeviceError(error) {
  return (
    error instanceof Error &&
    error.message.includes('This device is no longer authorized.')
  )
}

function appendHttpContext(message, vercelError, vercelId) {
  const context = []

  if (vercelError) {
    context.push(`Vercel error: ${vercelError}`)
  }

  if (vercelId) {
    context.push(`request id: ${vercelId}`)
  }

  if (!context.length) {
    return message
  }

  return `${message} [${context.join('; ')}]`
}

function looksLikeHtml(text) {
  return /^<!doctype html>|^<html[\s>]/i.test(text)
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength - 1)}…`
}

function waitForTermination(cleanup) {
  return new Promise((resolve) => {
    let finished = false

    const finish = async () => {
      if (finished) {
        return
      }

      finished = true
      await cleanup()
      resolve()
    }

    process.once('SIGINT', () => {
      void finish()
    })
    process.once('SIGTERM', () => {
      void finish()
    })
  })
}

function printUsage() {
  console.log('Usage:')
  console.log('  codex-usage connect [--site <url>] [--watch] [--codex-home <path>] [--label <name>]')
  console.log('  codex-usage pair <pair-url> [--watch] [--codex-home <path>] [--label <name>]')
  console.log('  codex-usage sync [--watch] [--codex-home <path>] [--label <name>]')
  console.log('  codex-usage sync --all [--watch] [--every <seconds>] [--store <accounts.json>]')
  console.log('  codex-usage login add [--store <accounts.json>]')
  console.log('  codex-usage login list [--store <accounts.json>]')
  console.log('  codex-usage login remove --email <email> [--store <accounts.json>]')
  for (const line of sharedLoginUsageLines) {
    console.log(line)
  }
}

function isDirectExecution() {
  const entryPath = process.argv[1]
  if (!entryPath) {
    return false
  }

  const modulePath = fileURLToPath(import.meta.url)
  try {
    return realpathSync(entryPath) === realpathSync(modulePath)
  } catch {
    return path.resolve(entryPath) === path.resolve(modulePath)
  }
}

if (isDirectExecution()) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
