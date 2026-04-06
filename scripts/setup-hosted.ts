import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
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
const projectRefPath = path.join(rootDir, 'supabase', '.temp', 'project-ref')
const supabaseBin = resolveSupabaseBin()

type SupabaseApiKey = {
  api_key?: string
  id?: string
  type?: string
}

function runSupabase(args: string[]) {
  return execFileSync(supabaseBin, args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
    // Fall through to common install paths.
  }

  const commonBins = ['/opt/homebrew/bin/supabase', '/usr/local/bin/supabase']
  const matchedBin = commonBins.find((candidate) => existsSync(candidate))
  return matchedBin ?? 'supabase'
}

async function resolveProjectRef() {
  const configuredRef = process.env.SUPABASE_PROJECT_REF?.trim()
  if (configuredRef) {
    return configuredRef
  }

  if (existsSync(projectRefPath)) {
    const value = (await readFile(projectRefPath, 'utf8')).trim()
    if (value) {
      return value
    }
  }

  throw new Error(
    'No linked Supabase project found. Run `supabase link --project-ref <ref>` first or set SUPABASE_PROJECT_REF.',
  )
}

async function ensureCollectorConfig() {
  if (existsSync(collectorConfigPath)) {
    console.log(`collector config already exists at ${collectorConfigPath}`)
    return
  }

  await copyFile(collectorConfigExamplePath, collectorConfigPath)
  console.log(`created ${collectorConfigPath}`)
}

function readKeys(projectRef: string) {
  const raw = runSupabase([
    'projects',
    'api-keys',
    '--project-ref',
    projectRef,
    '-o',
    'json',
  ])

  const keys = JSON.parse(raw) as SupabaseApiKey[]
  const anonKey =
    keys.find((key) => key.id === 'anon')?.api_key ??
    keys.find((key) => key.type === 'publishable')?.api_key
  const serviceRoleKey = keys.find((key) => key.id === 'service_role')?.api_key

  if (!anonKey || !serviceRoleKey) {
    throw new Error(
      'Unable to resolve hosted Supabase API keys for this project.',
    )
  }

  return {
    anonKey,
    serviceRoleKey,
    url: `https://${projectRef}.supabase.co`,
  }
}

async function writeEnvFiles(projectRef: string) {
  const env = readKeys(projectRef)

  const clientEnv = [
    `VITE_SUPABASE_URL=${env.url}`,
    `VITE_SUPABASE_ANON_KEY=${env.anonKey}`,
    '',
  ].join('\n')

  const collectorEnv = [
    `SUPABASE_URL=${env.url}`,
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
  console.log(`using Supabase CLI at ${supabaseBin}`)
  const projectRef = await resolveProjectRef()
  console.log(`using hosted project ${projectRef}`)

  await ensureCollectorConfig()
  await writeEnvFiles(projectRef)

  console.log('')
  console.log('hosted setup complete')
  console.log('next:')
  console.log('  npm run dev')
  console.log('  npm run collector')
}

await main()
