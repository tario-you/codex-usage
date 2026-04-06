#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_POLL_MS = 60_000
const CODEX_HELP_TIMEOUT_MS = 5_000
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
    await ensureCodexAppServerSupport()

    return new Promise((resolve, reject) => {
      const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        env: {
          ...process.env,
          ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

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
              ? 'The `codex` command is not installed on this machine.'
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

    const payload = await parseJsonResponse(response)
    if (!response.ok) {
      throw new Error(payload.error ?? 'Pairing failed.')
    }

    const config = {
      authMode: 'website-paired',
      codexHome,
      deviceId: payload.deviceId,
      deviceToken: payload.deviceToken,
      dashboardOrigin: new URL(pairUrl).origin,
      label: device.label,
      pollMs: payload.pollMs ?? DEFAULT_POLL_MS,
      syncUrl: payload.syncUrl,
    }

    await writeConfig(codexHome, config)
    console.log('Pairing complete.')
    console.log(`Config saved to ${resolveConfigPath(codexHome)}`)
    console.log(
      `Next: run \`${NPX_COMMAND} sync --watch\` on this machine for live updates.`,
    )

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

  try {
    await client.connect()

    if (existingConfig) {
      const dashboardUrl = await resolveExistingDashboardUrl(existingConfig, args)

      if (dashboardUrl) {
        await openDashboard(dashboardUrl)
      }

      await syncOnce(client, existingConfig, args)
      console.log('Dashboard opened.')

      if (args.options.watch) {
        await runWatchLoop(client, existingConfig, args)
      }

      return
    }

    const siteOrigin = resolveSiteOrigin(args.options.site)
    if (!siteOrigin) {
      throw new Error(
        'Pass --site <url> the first time you run connect, or set CODEX_USAGE_SITE_URL.',
      )
    }

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

    const payload = await parseJsonResponse(response)
    if (!response.ok) {
      throw new Error(payload.error ?? 'Unable to connect this machine.')
    }

    const config = {
      authMode: 'guest-link',
      codexHome,
      dashboardOrigin: siteOrigin,
      deviceId: payload.deviceId,
      deviceToken: payload.deviceToken,
      label: device.label,
      pollMs: payload.pollMs ?? DEFAULT_POLL_MS,
      syncUrl: payload.syncUrl,
    }

    await writeConfig(codexHome, config)
    await openDashboard(payload.dashboardUrl)
    console.log('Dashboard opened.')
    console.log(`Config saved to ${resolveConfigPath(codexHome)}`)
    console.log(
      `Next: rerun \`${NPX_COMMAND} connect --site "${siteOrigin}"\` to reopen this dashboard, or \`${NPX_COMMAND} sync --watch\` for live updates only.`,
    )

    if (args.options.watch) {
      await runWatchLoop(client, config, args)
    }
  } finally {
    await client.close()
  }
}

async function runSyncCommand(args) {
  const codexHome = resolveCodexHome(args.options['codex-home'])
  const config = await readConfig(codexHome)
  if (!config) {
    throw new Error(
      'No pairing config found. Run `connect` or pair this machine from the website first.',
    )
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

  const payload = await parseJsonResponse(response)
  if (!response.ok) {
    throw new Error(payload.error ?? 'Sync failed.')
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

    const payload = await parseJsonResponse(response)
    if (!response.ok) {
      throw new Error(payload.error ?? 'Unable to open the dashboard.')
    }

    return payload.dashboardUrl ?? null
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
        'No logged-in Codex account was found. Run `codex login` and try again.',
      )
    }

    console.log('No logged-in Codex account found yet. Waiting for login.')
    return null
  }

  const rateLimits = await client.request('account/rateLimits/read')
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
  } catch {
    console.log(`Open this URL in your browser: ${url}`)
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

    if (key === 'watch') {
      options.watch = true
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
    codexAppServerSupportPromise = inspectCodexCliForAppServer().catch(
      (error) => {
        codexAppServerSupportPromise = null
        throw error
      },
    )
  }

  await codexAppServerSupportPromise
}

async function inspectCodexCliForAppServer() {
  const [help, version] = await Promise.all([
    runCommandCapture('codex', ['--help'], { timeoutMs: CODEX_HELP_TIMEOUT_MS }),
    runCommandCapture('codex', ['--version'], {
      timeoutMs: CODEX_HELP_TIMEOUT_MS,
    }),
  ])

  const helpText = `${help.stdout}\n${help.stderr}`
  if (help.code === 0 && /\bapp-server\b/.test(helpText)) {
    return
  }

  const versionText = normalizeCodexVersion(version.stdout || version.stderr)
  throw new Error(
    `Installed Codex CLI ${versionText} does not support \`codex app-server\`. Update it with \`npm install -g @openai/codex\` and rerun this command.`,
  )
}

function runCommandCapture(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timeout = setTimeout(() => {
      if (settled) {
        return
      }

      settled = true
      child.kill('SIGTERM')
      reject(
        new Error(
          `Timed out while probing \`${command} ${args.join(' ')}\`.`,
        ),
      )
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.once('error', (error) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      reject(
        new Error(
          error.code === 'ENOENT'
            ? 'The `codex` command is not installed on this machine.'
            : error.message,
        ),
      )
    })

    child.once('close', (code, signal) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      resolve({
        code,
        signal,
        stderr: stderr.trim(),
        stdout: stdout.trim(),
      })
    })
  })
}

function normalizeCodexVersion(versionText) {
  const normalized = versionText.trim().replace(/^codex-cli\s+/i, '')
  return normalized || 'unknown'
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

  return JSON.parse(await readFile(configPath, 'utf8'))
}

async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => null)
  if (!payload || typeof payload !== 'object') {
    return {}
  }

  return payload
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
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
