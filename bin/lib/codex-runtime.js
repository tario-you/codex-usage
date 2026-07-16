import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const CODEX_HELP_TIMEOUT_MS = 15_000
const CODEX_REPAIR_TIMEOUT_MS = 120_000
const PRIVATE_CODEX_RUNTIME_DIR_NAME = 'codex-usage-runtime'

const require = createRequire(import.meta.url)

let resolvedCodexExecutable = null

export async function selectCodexExecutable(options = {}) {
  const diagnostics = []
  const candidates =
    options.candidates ?? resolveCodexExecutableCandidates(options)
  const inspect = options.inspect ?? inspectCodexCliForAppServer
  const shouldCache = Object.keys(options).length === 0
  const repairCodexRuntime =
    options.repairCodexRuntime ??
    (shouldCache && !isCodexAutoRepairDisabled()
      ? installPrivateCodexRuntime
      : null)

  for (const codexExecutable of candidates) {
    try {
      await inspect(codexExecutable)
      if (shouldCache) {
        resolvedCodexExecutable = codexExecutable
      }
      return codexExecutable
    } catch (error) {
      diagnostics.push(
        `${codexExecutable.label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  if (repairCodexRuntime) {
    if (shouldCache) {
      console.error(
        'No healthy Codex CLI was found. Repairing a private Codex runtime...',
      )
    }

    try {
      const repairedExecutable = await repairCodexRuntime()
      await inspect(repairedExecutable)
      if (shouldCache) {
        resolvedCodexExecutable = repairedExecutable
        console.error('Private Codex runtime repaired successfully.')
      }
      return repairedExecutable
    } catch (error) {
      diagnostics.push(
        `automatic private Codex repair: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  throw new Error(
    [
      'No usable Codex CLI with `app-server` support was found.',
      ...diagnostics.map((diagnostic) => `- ${diagnostic}`),
      isCodexAutoRepairDisabled()
        ? 'Automatic repair is disabled by CODEX_USAGE_DISABLE_AUTO_REPAIR.'
        : 'Automatic repair could not restore a private Codex runtime.',
      'Install or repair Codex with `npm install -g @openai/codex@latest`, then rerun this command.',
    ].join('\n'),
  )
}

export function resolveCodexExecutableCandidates(options = {}) {
  const shouldUseCache = Object.keys(options).length === 0
  if (shouldUseCache && resolvedCodexExecutable) {
    return [resolvedCodexExecutable]
  }

  const candidates = []
  const bundledBinPath =
    options.bundledBinPath === undefined
      ? resolveBundledCodexBin()
      : options.bundledBinPath
  const privateBinPath =
    options.privateBinPath === undefined
      ? resolvePrivateCodexBin()
      : options.privateBinPath
  const fileExists = options.fileExists ?? existsSync
  const pathValue = options.pathValue ?? process.env.PATH ?? ''
  const platform = options.platform ?? process.platform
  const resolveRealPath = options.resolveRealPath ?? realpathSync
  const bundledRealPath = safelyResolveRealPath(
    bundledBinPath,
    resolveRealPath,
  )
  const seenRealPaths = new Set()

  if (platform !== 'win32') {
    for (const directory of pathValue.split(path.delimiter)) {
      if (!directory) {
        continue
      }

      const command = path.join(directory, 'codex')
      if (!fileExists(command)) {
        continue
      }

      const realPath = safelyResolveRealPath(command, resolveRealPath)
      if (
        (bundledRealPath && realPath === bundledRealPath) ||
        (realPath && seenRealPaths.has(realPath))
      ) {
        continue
      }

      if (realPath) {
        seenRealPaths.add(realPath)
      }
      candidates.push({
        argsPrefix: [],
        command,
        label: `installed Codex (${command})`,
      })
    }
  } else {
    candidates.push({
      argsPrefix: [],
      command: 'codex',
      label: 'installed Codex',
    })
  }

  if (privateBinPath && fileExists(privateBinPath)) {
    candidates.push({
      argsPrefix: [privateBinPath],
      command: process.execPath,
      label: 'self-repaired @openai/codex',
    })
  }

  if (bundledBinPath) {
    candidates.push({
      argsPrefix: [bundledBinPath],
      command: process.execPath,
      label: 'bundled @openai/codex',
    })
  }

  return candidates
}

export async function installPrivateCodexRuntime(options = {}) {
  const runtimeDir = options.runtimeDir ?? resolvePrivateCodexRuntimeDir()
  const npmCommand =
    options.npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const runCommand = options.runCommand ?? runCommandCapture
  const fileExists = options.fileExists ?? existsSync

  await mkdir(runtimeDir, { recursive: true })
  const cacheDir = await mkdtemp(
    path.join(os.tmpdir(), 'codex-usage-npm-repair-'),
  )

  try {
    await rm(path.join(runtimeDir, 'node_modules'), {
      force: true,
      recursive: true,
    })

    const result = await runCommand(
      npmCommand,
      [
        'install',
        '--prefix',
        runtimeDir,
        '--no-save',
        '--package-lock=false',
        '--include=optional',
        '--omit=dev',
        '--audit=false',
        '--fund=false',
        '--prefer-online',
        '--cache',
        cacheDir,
        '@openai/codex@latest',
      ],
      { timeoutMs: CODEX_REPAIR_TIMEOUT_MS },
    )

    if (result.code !== 0) {
      throw new Error(
        `npm install failed: ${
          result.stderr || result.stdout || `exit code ${result.code}`
        }`,
      )
    }

    const privateBinPath = resolvePrivateCodexBin(runtimeDir)
    if (!fileExists(privateBinPath)) {
      throw new Error(
        `npm completed without installing the Codex launcher at ${privateBinPath}.`,
      )
    }

    return {
      argsPrefix: [privateBinPath],
      command: process.execPath,
      label: `self-repaired @openai/codex (${runtimeDir})`,
    }
  } finally {
    await rm(cacheDir, { force: true, recursive: true })
  }
}

async function inspectCodexCliForAppServer(codexExecutable) {
  const help = await runCommandCapture(
    codexExecutable.command,
    [...codexExecutable.argsPrefix, '--help'],
    { timeoutMs: CODEX_HELP_TIMEOUT_MS },
  )

  const helpText = `${help.stdout}\n${help.stderr}`
  if (help.code === 0 && /\bapp-server\b/.test(helpText)) {
    return
  }

  const version = await runCommandCapture(
    codexExecutable.command,
    [...codexExecutable.argsPrefix, '--version'],
    { timeoutMs: CODEX_HELP_TIMEOUT_MS },
  )
  const versionText = normalizeCodexVersion(version.stdout || version.stderr)
  throw new Error(
    `resolved Codex CLI ${versionText} does not support \`codex app-server\`.`,
  )
}

function resolveBundledCodexBin() {
  try {
    return require.resolve('@openai/codex/bin/codex.js')
  } catch {
    return null
  }
}

function resolvePrivateCodexRuntimeDir() {
  const configuredRuntimeDir = process.env.CODEX_USAGE_RUNTIME_DIR?.trim()
  if (configuredRuntimeDir) {
    return path.resolve(configuredRuntimeDir)
  }

  return path.join(os.homedir(), '.codex', PRIVATE_CODEX_RUNTIME_DIR_NAME)
}

function resolvePrivateCodexBin(runtimeDir = resolvePrivateCodexRuntimeDir()) {
  return path.join(
    runtimeDir,
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  )
}

function safelyResolveRealPath(value, resolveRealPath) {
  if (!value) {
    return null
  }

  try {
    return resolveRealPath(value)
  } catch {
    return null
  }
}

function isCodexAutoRepairDisabled() {
  return /^(1|true|yes)$/i.test(
    process.env.CODEX_USAGE_DISABLE_AUTO_REPAIR?.trim() ?? '',
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
        new Error(`Timed out while probing \`${command} ${args.join(' ')}\`.`),
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
            ? `The \`${command}\` command is not installed on this machine.`
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
