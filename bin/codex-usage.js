#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_POLL_MS = 60_000
const CONFIG_FILE_NAME = 'codex-usage-sync.json'

class StdioCodexClient {
  constructor({ codexHome }) {
    this.codexHome = codexHome
    this.child = null
    this.buffer = ''
    this.pending = new Map()
    this.requestId = 0
    this.notificationHandler = null
  }

  async connect() {
    if (this.child) {
      return
    }

    this.child = await this.spawnAppServer()
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      this.consumeStdout(chunk)
    })
    this.child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim()
      if (message) {
        console.error(`[codex] ${message}`)
      }
    })

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

    this.child.kill('SIGTERM')
    this.child = null

    for (const pending of this.pending.values()) {
      pending.reject(new Error('Codex app-server closed.'))
    }
    this.pending.clear()
  }

  onNotification(handler) {
    this.notificationHandler = handler
  }

  request(method, params) {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error('Codex app-server is not connected.')
    }

    const id = ++this.requestId
    this.child.stdin.write(
      `${JSON.stringify({
        id,
        jsonrpc: '2.0',
        method,
        ...(params ? { params } : {}),
      })}\n`,
    )

    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve })
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

  spawnAppServer() {
    return new Promise((resolve, reject) => {
      const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        env: {
          ...process.env,
          ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
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

      child.once('spawn', () => {
        child.on('exit', (code) => {
          if (code !== 0 && code !== null) {
            console.error(`[codex] app-server exited with code ${code}`)
          }
        })
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
      codexHome,
      deviceId: payload.deviceId,
      deviceToken: payload.deviceToken,
      label: device.label,
      pollMs: payload.pollMs ?? DEFAULT_POLL_MS,
      syncUrl: payload.syncUrl,
    }

    await writeConfig(codexHome, config)

    console.log('Pairing complete.')
    console.log(`Config saved to ${resolveConfigPath(codexHome)}`)
    console.log('Next: run `npx codex-usage sync --watch` on this machine for live updates.')

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
      'No pairing config found. Pair this machine from the website first.',
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
  console.log('  codex-usage pair <pair-url> [--watch] [--codex-home <path>] [--label <name>]')
  console.log('  codex-usage sync [--watch] [--codex-home <path>] [--label <name>]')
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
