import { existsSync } from 'node:fs'
import { copyFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

const rootDir = process.cwd()
const envLocalPath = path.join(rootDir, '.env.local')
const collectorEnvPath = path.join(rootDir, '.env.collector.local')
const collectorConfigPath = path.join(rootDir, 'collector.sources.json')
const collectorConfigExamplePath = path.join(
  rootDir,
  'collector.sources.example.json',
)

type SupabaseStatusEnv = {
  anonKey: string
  apiUrl: string
  serviceRoleKey: string
}

const SUPABASE_STATUS_RETRY_MS = 2_000
const SUPABASE_STATUS_RETRY_ATTEMPTS = 10
const supabaseBin = resolveSupabaseBin()

function runSupabase(args: string[]) {
  return execFileSync(supabaseBin, args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function tryGetSupabaseEnv() {
  try {
    const raw = runSupabase(['status', '-o', 'env'])
    return parseSupabaseStatusEnv(raw)
  } catch {
    return null
  }
}

function parseSupabaseStatusEnv(raw: string): SupabaseStatusEnv {
  const pairs = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=')
      if (separator === -1) {
        return null
      }

      const key = line.slice(0, separator).trim()
      const value = stripWrappingQuotes(line.slice(separator + 1).trim())
      return [key, value] as const
    })
    .filter((entry): entry is readonly [string, string] => entry !== null)

  const env = Object.fromEntries(pairs)
  const apiUrl = env.API_URL ?? env.SUPABASE_URL
  const anonKey = env.ANON_KEY ?? env.SUPABASE_ANON_KEY
  const serviceRoleKey =
    env.SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY

  if (!apiUrl || !anonKey || !serviceRoleKey) {
    throw new Error(
      `Unexpected supabase status output. Missing one of API_URL, ANON_KEY, or SERVICE_ROLE_KEY. Saw keys: ${Object.keys(
        env,
      )
        .sort()
        .join(', ')}`,
    )
  }

  return { anonKey, apiUrl, serviceRoleKey }
}

function stripWrappingQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}

function resolveSupabaseBin() {
  const configuredBin = process.env.SUPABASE_BIN?.trim()
  if (configuredBin) {
    return configuredBin
  }

  try {
    const shellResolved = execFileSync(
      '/bin/zsh',
      ['-lc', 'command -v supabase'],
      {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim()

    if (shellResolved) {
      return shellResolved
    }
  } catch {
    // Fall back to common install locations below.
  }

  const commonBins = ['/opt/homebrew/bin/supabase', '/usr/local/bin/supabase']
  const matchedBin = commonBins.find((candidate) => existsSync(candidate))
  return matchedBin ?? 'supabase'
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForSupabaseEnv() {
  for (let attempt = 0; attempt < SUPABASE_STATUS_RETRY_ATTEMPTS; attempt += 1) {
    const env = tryGetSupabaseEnv()
    if (env) {
      return env
    }

    await sleep(SUPABASE_STATUS_RETRY_MS)
  }

  return null
}

async function ensureCollectorConfig() {
  if (existsSync(collectorConfigPath)) {
    console.log(`collector config already exists at ${collectorConfigPath}`)
    return
  }

  await copyFile(collectorConfigExamplePath, collectorConfigPath)
  console.log(`created ${collectorConfigPath}`)
}

async function writeEnvFiles(env: SupabaseStatusEnv) {
  const clientEnv = [
    `VITE_SUPABASE_URL=${env.apiUrl}`,
    `VITE_SUPABASE_ANON_KEY=${env.anonKey}`,
    '',
  ].join('\n')

  const collectorEnv = [
    `SUPABASE_URL=${env.apiUrl}`,
    `SUPABASE_SERVICE_ROLE_KEY=${env.serviceRoleKey}`,
    'COLLECTOR_CONFIG_PATH=./collector.sources.json',
    '',
  ].join('\n')

  await writeFile(envLocalPath, clientEnv, 'utf8')
  await writeFile(collectorEnvPath, collectorEnv, 'utf8')

  console.log(`wrote ${envLocalPath}`)
  console.log(`wrote ${collectorEnvPath}`)
}

async function main() {
  console.log('checking local Supabase status...')
  console.log(`using Supabase CLI at ${supabaseBin}`)
  let env = tryGetSupabaseEnv()

  if (!env) {
    console.log('local Supabase is not ready; starting it now...')
    try {
      execFileSync(supabaseBin, ['start'], {
        cwd: rootDir,
        stdio: 'inherit',
      })
    } catch (error) {
      console.warn(
        'supabase start did not complete cleanly; checking whether the stack is already becoming healthy...',
      )

      if (error instanceof Error && error.message) {
        console.warn(error.message)
      }
    }

    env = await waitForSupabaseEnv()
  }

  if (!env) {
    throw new Error(
      'Unable to read local Supabase env after waiting for startup. Run `supabase status -o env` to inspect the local stack.',
    )
  }

  await ensureCollectorConfig()
  await writeEnvFiles(env)

  console.log('')
  console.log('local setup complete')
  console.log('next:')
  console.log('  npm run dev')
  console.log('  npm run collector')
}

await main()
