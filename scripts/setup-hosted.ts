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
const supabaseConfigPath = path.join(rootDir, 'supabase', 'config.toml')
const projectRefPath = path.join(rootDir, 'supabase', '.temp', 'project-ref')
const supabaseBin = resolveSupabaseBin()
const defaultHostedSiteUrl =
  'https://codex-use-age-tario-yous-projects.vercel.app'
const localAuthRedirectUrls = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'https://127.0.0.1:3000',
]

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

function runSupabaseInteractive(args: string[]) {
  execFileSync(supabaseBin, args, {
    cwd: rootDir,
    stdio: 'inherit',
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

function resolveHostedAuthRedirects() {
  const siteUrl = normalizeOrigin(
    process.env.HOSTED_SITE_URL?.trim() || defaultHostedSiteUrl,
    'HOSTED_SITE_URL',
  )
  const extraRedirectUrls = (process.env.HOSTED_ADDITIONAL_REDIRECT_URLS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) =>
      normalizeOrigin(value, 'HOSTED_ADDITIONAL_REDIRECT_URLS'),
    )

  return {
    siteUrl,
    redirectUrls: Array.from(
      new Set([...localAuthRedirectUrls, siteUrl, ...extraRedirectUrls]),
    ),
  }
}

function normalizeOrigin(value: string, envName: string) {
  try {
    return new URL(value).origin
  } catch {
    throw new Error(`Invalid URL for ${envName}: ${value}`)
  }
}

function replaceHostedAuthConfig(
  source: string,
  siteUrl: string,
  redirectUrls: string[],
) {
  const lines = source.split('\n')
  const authStartIndex = lines.findIndex((line) => line.trim() === '[auth]')

  if (authStartIndex === -1) {
    throw new Error('Unable to locate the [auth] section in supabase/config.toml.')
  }

  let authEndIndex = lines.length
  for (let index = authStartIndex + 1; index < lines.length; index += 1) {
    if (/^\[[^\]]+\]$/.test(lines[index].trim())) {
      authEndIndex = index
      break
    }
  }

  const findAuthLine = (pattern: RegExp) => {
    for (let index = authStartIndex + 1; index < authEndIndex; index += 1) {
      if (pattern.test(lines[index])) {
        return index
      }
    }

    return -1
  }

  const siteUrlLineIndex = findAuthLine(/^\s*site_url = /)
  const redirectUrlsStartIndex = findAuthLine(/^\s*additional_redirect_urls = \[/)

  if (siteUrlLineIndex === -1 || redirectUrlsStartIndex === -1) {
    throw new Error(
      'Unable to locate Supabase auth redirect settings in supabase/config.toml.',
    )
  }

  let redirectUrlsEndIndex = -1
  for (let index = redirectUrlsStartIndex + 1; index < authEndIndex; index += 1) {
    if (lines[index].trim() === ']') {
      redirectUrlsEndIndex = index
      break
    }
  }

  if (redirectUrlsEndIndex === -1) {
    throw new Error(
      'Unable to locate the end of additional_redirect_urls in supabase/config.toml.',
    )
  }

  lines[siteUrlLineIndex] = `site_url = "${siteUrl}"`
  lines.splice(
    redirectUrlsStartIndex,
    redirectUrlsEndIndex - redirectUrlsStartIndex + 1,
    'additional_redirect_urls = [',
    ...redirectUrls.map((url) => `  "${url}",`),
    ']',
  )

  return lines.join('\n')
}

async function pushHostedAuthConfig() {
  const { siteUrl, redirectUrls } = resolveHostedAuthRedirects()
  const originalConfig = await readFile(supabaseConfigPath, 'utf8')
  const hostedConfig = replaceHostedAuthConfig(
    originalConfig,
    siteUrl,
    redirectUrls,
  )

  await writeFile(supabaseConfigPath, hostedConfig, 'utf8')

  try {
    console.log(`pushing hosted auth config for ${siteUrl}`)
    console.log(`allowing auth redirects for: ${redirectUrls.join(', ')}`)
    runSupabaseInteractive(['config', 'push', '--yes'])
  } finally {
    await writeFile(supabaseConfigPath, originalConfig, 'utf8')
  }
}

async function main() {
  console.log(`using Supabase CLI at ${supabaseBin}`)
  const projectRef = await resolveProjectRef()
  console.log(`using hosted project ${projectRef}`)

  await ensureCollectorConfig()
  await writeEnvFiles(projectRef)
  await pushHostedAuthConfig()
  console.log('applying pending hosted migrations...')
  runSupabaseInteractive(['db', 'push'])

  console.log('')
  console.log('hosted setup complete')
  console.log('next:')
  console.log('  npm run dev')
  console.log('  npm run collector')
}

await main()
