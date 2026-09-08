import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const AUTH_FILE_NAME = 'auth.json'
export const SHARED_LOGIN_BACKUP_SUFFIX = '.before-shared-login'

/**
 * A recipient's copy carries `last_refresh` shifted one day into the future.
 * Codex refreshes ChatGPT tokens once `last_refresh` is eight days old, and
 * OpenAI rotates refresh tokens with reuse detection, so two machines holding
 * the same generation must not race for the refresh. The shift makes the
 * owner's machine the usual refresher; the recipient's `use --watch` pulls the
 * new generation long before its own timer fires. Ordering between
 * generations never uses `last_refresh`; it uses the access token's `iat`.
 */
export const RECIPIENT_LAST_REFRESH_SHIFT_MS = 24 * 60 * 60 * 1000

const TOKEN_KEYS = ['id_token', 'access_token', 'refresh_token', 'account_id']
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile'

export function resolveAuthFilePath(codexHome) {
  return path.join(codexHome, AUTH_FILE_NAME)
}

export function resolveDefaultSwitcherStorePath() {
  return (
    process.env.CODEX_SWITCHER_STORE?.trim() ||
    path.join(os.homedir(), '.codex-switcher', 'accounts.json')
  )
}

export async function readJsonFile(filePath) {
  if (!existsSync(filePath)) {
    return null
  }

  return JSON.parse(await readFile(filePath, 'utf8'))
}

export function validateSharedLoginFile(file, label = 'The Codex auth file') {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error(`${label} is not a JSON object.`)
  }

  if (file.OPENAI_API_KEY) {
    throw new Error(
      `${label} uses an API key. Only ChatGPT plan logins can be shared.`,
    )
  }

  if (file.auth_mode && String(file.auth_mode).toLowerCase() !== 'chatgpt') {
    throw new Error(
      `${label} uses auth mode "${file.auth_mode}". Only ChatGPT plan logins can be shared.`,
    )
  }

  for (const key of TOKEN_KEYS) {
    if (typeof file.tokens?.[key] !== 'string' || !file.tokens[key]) {
      throw new Error(
        `${label} is missing tokens.${key}. Run \`codex login\` on this machine first.`,
      )
    }
  }

  if (typeof file.last_refresh !== 'string' || !file.last_refresh) {
    throw new Error(`${label} is missing last_refresh.`)
  }

  return file
}

export function fingerprintSharedLogin(file) {
  return createHash('sha256')
    .update(TOKEN_KEYS.map((key) => file.tokens[key]).join('\n'))
    .digest('hex')
}

export function decodeJwtPayload(token) {
  const segments = typeof token === 'string' ? token.split('.') : []
  if (segments.length < 2) {
    return null
  }

  try {
    const payload = JSON.parse(
      Buffer.from(segments[1], 'base64url').toString('utf8'),
    )
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : null
  } catch {
    return null
  }
}

export function describeSharedLogin(file) {
  const accessClaims = decodeJwtPayload(file.tokens?.access_token) ?? {}
  const idClaims = decodeJwtPayload(file.tokens?.id_token) ?? {}
  const accessAuth = asObject(accessClaims[OPENAI_AUTH_CLAIM])
  const accessProfile = asObject(accessClaims[OPENAI_PROFILE_CLAIM])
  const idAuth = asObject(idClaims[OPENAI_AUTH_CLAIM])
  const email = firstString([accessProfile.email, idClaims.email])?.toLowerCase()
  const issuedAtSeconds = firstNumber([accessClaims.iat, idClaims.iat])

  if (!email) {
    throw new Error('The Codex auth file does not carry an account email.')
  }

  if (issuedAtSeconds == null) {
    throw new Error('The Codex auth file does not carry a token issue time.')
  }

  const expiresAtSeconds = firstNumber([accessClaims.exp])

  return {
    accountId:
      firstString([
        file.tokens?.account_id,
        accessAuth.chatgpt_account_id,
        idAuth.chatgpt_account_id,
      ]) ?? null,
    email,
    expiresAt:
      expiresAtSeconds == null
        ? null
        : new Date(expiresAtSeconds * 1000).toISOString(),
    issuedAt: new Date(issuedAtSeconds * 1000).toISOString(),
    planType:
      firstString([accessAuth.chatgpt_plan_type, idAuth.chatgpt_plan_type]) ??
      null,
  }
}

export function shiftLastRefresh(lastRefresh, shiftMs) {
  const parsed = Date.parse(lastRefresh)
  const base = Number.isFinite(parsed) ? parsed : Date.now()
  return new Date(base + shiftMs).toISOString()
}

export function buildRecipientAuthFile(serverFile) {
  return {
    ...serverFile,
    OPENAI_API_KEY: null,
    auth_mode: serverFile.auth_mode ?? 'chatgpt',
    last_refresh: shiftLastRefresh(
      serverFile.last_refresh,
      RECIPIENT_LAST_REFRESH_SHIFT_MS,
    ),
  }
}

export async function writeJsonFilePrivately(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  await rename(tempPath, filePath)
  await chmod(filePath, 0o600)
}

export async function backupFileOnce(filePath) {
  const backupPath = `${filePath}${SHARED_LOGIN_BACKUP_SUFFIX}`

  if (existsSync(filePath) && !existsSync(backupPath)) {
    await copyFile(filePath, backupPath)
    await chmod(backupPath, 0o600)
  }

  return existsSync(backupPath) ? backupPath : null
}

export function findSwitcherStoreAccount(store, email) {
  const accounts = Array.isArray(store?.accounts) ? store.accounts : []
  const wanted = email.toLowerCase()

  return (
    accounts.find(
      (account) =>
        typeof account?.email === 'string' &&
        account.email.toLowerCase() === wanted,
    ) ?? null
  )
}

export function buildAuthFileFromStoreAccount(account) {
  const tokens = {}
  for (const key of TOKEN_KEYS) {
    tokens[key] = account?.auth_data?.[key]
  }

  const file = {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    last_refresh: new Date().toISOString(),
    tokens,
  }

  validateSharedLoginFile(file, `The switcher entry for ${account?.email ?? 'that account'}`)
  file.last_refresh = describeSharedLogin(file).issuedAt
  return file
}

export function applyAuthFileToStoreAccount(account, authFile) {
  account.auth_data = {
    ...(account.auth_data ?? {}),
    access_token: authFile.tokens.access_token,
    account_id: authFile.tokens.account_id,
    id_token: authFile.tokens.id_token,
    refresh_token: authFile.tokens.refresh_token,
  }
  return account
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function firstString(values) {
  return values.find((value) => typeof value === 'string' && value.length > 0)
}

function firstNumber(values) {
  return values.find(
    (value) => typeof value === 'number' && Number.isFinite(value),
  )
}
