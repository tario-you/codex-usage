import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveCodexExecutableCandidates,
  selectCodexExecutable,
} from '../bin/codex-usage.js'

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
