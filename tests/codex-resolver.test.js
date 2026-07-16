import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  installPrivateCodexRuntime,
  resolveCodexExecutableCandidates,
  selectCodexExecutable,
} from '../bin/lib/codex-runtime.js'

test('skips the npx shim for the bundled Codex launcher', () => {
  const bundledBinPath = '/npx/node_modules/@openai/codex/bin/codex.js'
  const realPaths = new Map([
    [bundledBinPath, bundledBinPath],
    ['/npx/bin/codex', bundledBinPath],
    ['/opt/bin/codex', '/opt/global/@openai/codex/bin/codex.js'],
  ])

  const candidates = resolveCodexExecutableCandidates({
    bundledBinPath,
    fileExists: (value) => realPaths.has(value),
    pathValue: '/npx/bin:/opt/bin',
    platform: 'darwin',
    resolveRealPath: (value) => {
      const resolved = realPaths.get(value)
      if (!resolved) {
        throw new Error(`Missing test path: ${value}`)
      }
      return resolved
    },
  })

  assert.deepEqual(
    candidates.map(({ argsPrefix, command }) => ({ argsPrefix, command })),
    [
      { argsPrefix: [], command: '/opt/bin/codex' },
      { argsPrefix: [bundledBinPath], command: process.execPath },
    ],
  )
})

test('falls back after a broken Codex candidate fails inspection', async () => {
  const broken = {
    argsPrefix: [],
    command: '/broken/codex',
    label: 'broken Codex',
  }
  const working = {
    argsPrefix: [],
    command: '/working/codex',
    label: 'working Codex',
  }

  const selected = await selectCodexExecutable({
    candidates: [broken, working],
    inspect: async (candidate) => {
      if (candidate === broken) {
        throw new Error('native executable is missing')
      }
    },
  })

  assert.equal(selected, working)
})

test('reuses a previously repaired private Codex runtime', () => {
  const privateBinPath = '/private/node_modules/@openai/codex/bin/codex.js'
  const candidates = resolveCodexExecutableCandidates({
    bundledBinPath: '/bundled/@openai/codex/bin/codex.js',
    fileExists: (value) => value === privateBinPath,
    pathValue: '',
    platform: 'darwin',
    privateBinPath,
    resolveRealPath: (value) => value,
  })

  assert.deepEqual(candidates[0], {
    argsPrefix: [privateBinPath],
    command: process.execPath,
    label: 'self-repaired @openai/codex',
  })
})

test('automatically repairs Codex after every candidate is broken', async () => {
  const broken = {
    argsPrefix: [],
    command: '/broken/codex',
    label: 'broken Codex',
  }
  const repaired = {
    argsPrefix: ['/private/codex.js'],
    command: process.execPath,
    label: 'self-repaired Codex',
  }
  let repairCalls = 0

  const selected = await selectCodexExecutable({
    candidates: [broken],
    inspect: async (candidate) => {
      if (candidate === broken) {
        throw new Error('native executable is missing')
      }
    },
    repairCodexRuntime: async () => {
      repairCalls += 1
      return repaired
    },
  })

  assert.equal(repairCalls, 1)
  assert.equal(selected, repaired)
})

test('installs a private Codex runtime with a clean npm cache', async (t) => {
  const runtimeDir = await mkdtemp(
    path.join(os.tmpdir(), 'codex-usage-runtime-test-'),
  )
  t.after(() => rm(runtimeDir, { force: true, recursive: true }))
  const expectedBinPath = path.join(
    runtimeDir,
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  )
  let installCall = null

  const executable = await installPrivateCodexRuntime({
    fileExists: (value) => value === expectedBinPath,
    npmCommand: '/test/npm',
    runCommand: async (command, args, commandOptions) => {
      installCall = { args, command, commandOptions }
      return { code: 0, stderr: '', stdout: '' }
    },
    runtimeDir,
  })

  assert.equal(installCall?.command, '/test/npm')
  assert.equal(installCall?.commandOptions.timeoutMs, 120_000)
  assert.ok(installCall?.args.includes('--include=optional'))
  assert.ok(installCall?.args.includes('--prefer-online'))
  assert.ok(installCall?.args.includes('@openai/codex@latest'))
  const cacheArgIndex = installCall?.args.indexOf('--cache') ?? -1
  assert.ok(cacheArgIndex >= 0)
  assert.equal(existsSync(installCall.args[cacheArgIndex + 1]), false)
  assert.deepEqual(executable, {
    argsPrefix: [expectedBinPath],
    command: process.execPath,
    label: `self-repaired @openai/codex (${runtimeDir})`,
  })
})

test('reports every failed Codex candidate', async () => {
  await assert.rejects(
    selectCodexExecutable({
      candidates: [
        { argsPrefix: [], command: '/one/codex', label: 'first Codex' },
        { argsPrefix: [], command: '/two/codex', label: 'second Codex' },
      ],
      inspect: async (candidate) => {
        throw new Error(`${candidate.command} is unusable`)
      },
    }),
    (error) => {
      assert.match(error.message, /first Codex: \/one\/codex is unusable/)
      assert.match(error.message, /second Codex: \/two\/codex is unusable/)
      return true
    },
  )
})
