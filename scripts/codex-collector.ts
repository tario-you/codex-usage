import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

import { createClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'
import { z } from 'zod'

import type { Database, Json } from '../src/lib/database.types'
import {
  parseCreditsBalance,
  unixSecondsToIso,
  type CodexAccountReadResponse,
  type CodexRateLimitsResponse,
} from '../src/shared/codex'

const rootDir = process.cwd()
const once = process.argv.includes('--once')
const ONE_SHOT_CONNECT_ATTEMPTS = 15
const ONE_SHOT_CONNECT_DELAY_MS = 1_000

for (const fileName of ['.env.collector.local', '.env.local', '.env']) {
  const envPath = path.resolve(rootDir, fileName)
  if (existsSync(envPath)) {
    loadEnv({ path: envPath })
  }
}

const envSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  COLLECTOR_CONFIG_PATH: z.string().default('./collector.sources.json'),
})

const sourceSchema = z
  .object({
    sourceKey: z.string().min(1),
    label: z.string().min(1),
    wsUrl: z.string().url().optional(),
    port: z.number().int().positive().optional(),
    codexHome: z.string().optional(),
    autoStart: z.boolean().default(false),
    pollMs: z.number().int().positive().default(60_000),
    enabled: z.boolean().default(true),
  })
  .superRefine((source, context) => {
    if (!source.wsUrl && !source.port) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either wsUrl or port is required.',
        path: ['wsUrl'],
      })
    }
  })

type SourceConfig = z.infer<typeof sourceSchema>

const env = envSchema.parse({
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  COLLECTOR_CONFIG_PATH: process.env.COLLECTOR_CONFIG_PATH,
})

const configPath = path.resolve(rootDir, env.COLLECTOR_CONFIG_PATH)
if (!existsSync(configPath)) {
  console.error(
    `collector config not found at ${configPath}. Copy collector.sources.example.json to collector.sources.json first.`,
  )
  process.exit(1)
}

const parsedSources = z
  .array(sourceSchema)
  .parse(JSON.parse(await readFile(configPath, 'utf8')))
const sources = parsedSources.filter((source) => source.enabled)

if (!sources.length) {
  console.error('No enabled collector sources found.')
  process.exit(1)
}

const supabase = createClient<Database>(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
)

let shuttingDown = false

class CodexSourceMonitor {
  private child: ChildProcess | null = null
  private pending = new Map<
    number,
    { reject: (reason?: unknown) => void; resolve: (value: unknown) => void }
  >()
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private requestId = 0
  private socket: WebSocket | null = null
  private source: SourceConfig
  private wsUrl: string

  constructor(source: SourceConfig) {
    this.source = source
    this.wsUrl = source.wsUrl ?? `ws://127.0.0.1:${source.port}`
  }

  async start() {
    if (this.source.autoStart) {
      this.spawnAppServer()
    }

    if (once) {
      await this.connectOnce()
      await this.runCycle()
      await this.stop()
      return
    }

    while (!shuttingDown) {
      try {
        await this.connectAndWatch()
      } catch (error) {
        this.log(`connection loop failed: ${stringifyError(error)}`)
      }

      if (!shuttingDown) {
        await delay(2_000)
      }
    }
  }

  async stop() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }

    this.socket?.close()
    this.socket = null

    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
    }
  }

  private async connectAndWatch() {
    await this.connect()
    await this.runCycle()

    this.pollInterval = setInterval(() => {
      void this.runCycle()
    }, this.source.pollMs)

    await new Promise<void>((resolve) => {
      this.socket?.addEventListener('close', () => resolve(), { once: true })
    })
  }

  private async connect() {
    this.log(`connecting to ${this.wsUrl}`)
    this.socket = await this.openSocket()
    this.socket.addEventListener('message', (event) => {
      void this.handleMessage(String(event.data))
    })

    this.socket.addEventListener('close', () => {
      this.log('socket closed')
    })

    await this.request('initialize', {
      capabilities: {},
      clientInfo: { name: 'codex-usage-collector', version: '0.1.0' },
    })
  }

  private async connectOnce() {
    let lastError: unknown = null

    for (
      let attempt = 1;
      attempt <= ONE_SHOT_CONNECT_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await this.connect()
        return
      } catch (error) {
        lastError = error
        if (attempt === ONE_SHOT_CONNECT_ATTEMPTS) {
          break
        }

        this.log(
          `waiting for app-server (${attempt}/${ONE_SHOT_CONNECT_ATTEMPTS})`,
        )
        await delay(ONE_SHOT_CONNECT_DELAY_MS)
      }
    }

    throw lastError ?? new Error(`Unable to connect to ${this.wsUrl}`)
  }

  private async runCycle() {
    try {
      const accountState = (await this.request('account/read', {
        refreshToken: false,
      })) as CodexAccountReadResponse

      if (!accountState.account) {
        this.log('no logged-in account yet; waiting for login')
        return
      }

      const rateLimits = (await this.request(
        'account/rateLimits/read',
      )) as CodexRateLimitsResponse

      await persistSnapshot(this.source, accountState, rateLimits)
      this.log('snapshot stored')
    } catch (error) {
      this.log(`sync failed: ${stringifyError(error)}`)
    }
  }

  private handleNotification(method: string) {
    if (
      method === 'account/login/completed' ||
      method === 'account/rateLimits/updated' ||
      method === 'account/updated'
    ) {
      this.scheduleRefresh()
    }
  }

  private scheduleRefresh() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }

    this.refreshTimer = setTimeout(() => {
      void this.runCycle()
    }, 500)
  }

  private async handleMessage(payload: string) {
    const message = JSON.parse(payload) as {
      error?: { message?: string }
      id?: number
      method?: string
      result?: unknown
    }

    if (typeof message.id === 'number') {
      const pendingRequest = this.pending.get(message.id)
      if (!pendingRequest) {
        return
      }

      this.pending.delete(message.id)

      if (message.error) {
        pendingRequest.reject(
          new Error(message.error.message ?? 'Unknown app-server error'),
        )
        return
      }

      pendingRequest.resolve(message.result)
      return
    }

    if (message.method) {
      this.handleNotification(message.method)
    }
  }

  private openSocket() {
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl)

      const handleError = () => {
        socket.removeEventListener('open', handleOpen)
        reject(new Error(`Unable to connect to ${this.wsUrl}`))
      }

      const handleOpen = () => {
        socket.removeEventListener('error', handleError)
        resolve(socket)
      }

      socket.addEventListener('error', handleError, { once: true })
      socket.addEventListener('open', handleOpen, { once: true })
    })
  }

  private request(method: string, params?: unknown) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Socket is not open')
    }

    const id = ++this.requestId
    this.socket.send(
      JSON.stringify({
        id,
        jsonrpc: '2.0',
        method,
        ...(params ? { params } : {}),
      }),
    )

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { reject, resolve })
    })
  }

  private spawnAppServer() {
    if (this.child) {
      return
    }

    const codexHome = this.source.codexHome
      ? expandHomeDirectory(this.source.codexHome)
      : undefined

    const child = spawn(
      'codex',
      ['app-server', '--listen', this.wsUrl],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    this.child = child

    child.stdout?.on('data', (chunk) => {
      const line = chunk.toString().trim()
      if (line) {
        this.log(line)
      }
    })

    child.stderr?.on('data', (chunk) => {
      const line = chunk.toString().trim()
      if (line) {
        this.log(line)
      }
    })

    child.on('exit', (code) => {
      this.log(`app-server exited with code ${code ?? 'unknown'}`)
      this.child = null
    })
  }

  private log(message: string) {
    console.log(`[${this.source.sourceKey}] ${message}`)
  }
}

async function persistSnapshot(
  source: SourceConfig,
  accountState: CodexAccountReadResponse,
  rateLimits: CodexRateLimitsResponse,
) {
  const sourceCodexHome = source.codexHome
    ? expandHomeDirectory(source.codexHome)
    : null
  const account = accountState.account
  const email =
    account?.type === 'chatgpt' && account.email
      ? account.email.toLowerCase()
      : null
  const accountKey = email ? `chatgpt:${email}` : `source:${source.sourceKey}`
  const nowIso = new Date().toISOString()
  const primary = rateLimits.rateLimits.primary
  const secondary = rateLimits.rateLimits.secondary

  const { data: accountRecord, error: upsertError } = await supabase
    .from('codex_accounts')
    .upsert(
      {
        account_key: accountKey,
        codex_home: sourceCodexHome,
        display_name: email ? null : source.label,
        email,
        last_seen_at: nowIso,
        last_snapshot_at: nowIso,
        metadata: {
          auth_type: account?.type ?? null,
          limit_ids: Object.keys(rateLimits.rateLimitsByLimitId ?? {}),
          ws_url: source.wsUrl ?? `ws://127.0.0.1:${source.port}`,
        },
        plan_type:
          rateLimits.rateLimits.planType ??
          (account?.type === 'chatgpt' ? account.planType ?? null : null),
        source_key: source.sourceKey,
        source_label: source.label,
      },
      { onConflict: 'account_key' },
    )
    .select('id')
    .single()

  if (upsertError || !accountRecord) {
    throw upsertError ?? new Error('Failed to upsert account')
  }

  const snapshotInsert: Database['public']['Tables']['codex_usage_snapshots']['Insert'] =
    {
      account_id: accountRecord.id,
      credits_balance: parseCreditsBalance(rateLimits.rateLimits.credits?.balance),
      fetched_at: nowIso,
      has_credits: rateLimits.rateLimits.credits?.hasCredits ?? null,
      primary_resets_at: unixSecondsToIso(primary?.resetsAt),
      primary_used_percent: primary?.usedPercent ?? null,
      primary_window_mins: primary?.windowDurationMins ?? null,
      raw_rate_limits: rateLimits.rateLimits as unknown as Json,
      raw_rate_limits_by_limit_id: (rateLimits.rateLimitsByLimitId ??
        {}) as unknown as Json,
      secondary_resets_at: unixSecondsToIso(secondary?.resetsAt),
      secondary_used_percent: secondary?.usedPercent ?? null,
      secondary_window_mins: secondary?.windowDurationMins ?? null,
      source_key: source.sourceKey,
      unlimited_credits: rateLimits.rateLimits.credits?.unlimited ?? null,
    }

  const { error: snapshotError } = await supabase
    .from('codex_usage_snapshots')
    .insert(snapshotInsert)

  if (snapshotError) {
    throw snapshotError
  }
}

function expandHomeDirectory(value: string) {
  if (!value.startsWith('~/')) {
    return value
  }

  return path.join(os.homedir(), value.slice(2))
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const monitors = sources.map((source) => new CodexSourceMonitor(source))

process.on('SIGINT', () => {
  shuttingDown = true
  void Promise.all(monitors.map((monitor) => monitor.stop())).finally(() => {
    process.exit(0)
  })
})

process.on('SIGTERM', () => {
  shuttingDown = true
  void Promise.all(monitors.map((monitor) => monitor.stop())).finally(() => {
    process.exit(0)
  })
})

await Promise.all(monitors.map((monitor) => monitor.start()))
