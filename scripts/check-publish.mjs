#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const rootDir = path.resolve(import.meta.dirname, '..')
const packageJsonPath = path.join(rootDir, 'package.json')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
const packageName = packageJson.name
const packageVersion = packageJson.version
const binEntries = Object.entries(packageJson.bin ?? {})

if (!packageName || !packageVersion) {
  throw new Error('package.json must define both `name` and `version`.')
}

if (binEntries.length === 0) {
  throw new Error('package.json must declare at least one CLI entry in `bin`.')
}

for (const [commandName, relativePath] of binEntries) {
  if (!commandName || /[\\/]/.test(commandName)) {
    throw new Error(`Invalid bin command name: ${commandName}`)
  }

  const normalizedPath = String(relativePath).replace(/^\.\//, '')
  const absolutePath = path.join(rootDir, normalizedPath)

  if (!existsSync(absolutePath)) {
    throw new Error(`Bin target is missing for \`${commandName}\`: ${normalizedPath}`)
  }
}

const packResult = JSON.parse(
  execFileSync(npmCommand, ['pack', '--dry-run', '--json'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
)

const packageArchive = packResult[0]
const packedFiles = new Set(packageArchive.files.map((entry) => entry.path))

for (const requiredFile of ['README.md', 'package.json']) {
  if (!packedFiles.has(requiredFile)) {
    throw new Error(`Publish tarball is missing required file: ${requiredFile}`)
  }
}

for (const [, relativePath] of binEntries) {
  const packedPath = String(relativePath).replace(/^\.\//, '')
  if (!packedFiles.has(packedPath)) {
    throw new Error(`Publish tarball is missing bin target: ${packedPath}`)
  }
}

try {
  const publishedVersion = execFileSync(
    npmCommand,
    ['view', `${packageName}@${packageVersion}`, 'version', '--json'],
    {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim()

  if (publishedVersion) {
    throw new Error(
      [
        `${packageName}@${packageVersion} is already published on npm.`,
        'Run `npm version patch` (or `npm version minor` / `npm version major`) before publishing again.',
      ].join(' '),
    )
  }
} catch (error) {
  const stderr = `${error.stdout ?? ''}\n${error.stderr ?? ''}`

  if (!/E404|404 Not Found|is not in this registry/i.test(stderr)) {
    throw error
  }
}

console.log(
  `Publish check passed for ${packageName}@${packageVersion}. Tarball contains ${packageArchive.entryCount} files and this version is not yet on npm.`,
)
