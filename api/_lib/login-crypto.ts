import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const LOGIN_ENCRYPTION_KEY_VERSION = 1
export const LOGIN_ENCRYPTION_KEY_ENV = 'CODEX_LOGIN_ENCRYPTION_KEY'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export class LoginSharingUnavailableError extends Error {
  constructor(
    message = 'Login sharing is not configured on this server. Set CODEX_LOGIN_ENCRYPTION_KEY.',
  ) {
    super(message)
    this.name = 'LoginSharingUnavailableError'
  }
}

export function loadLoginEncryptionKey(
  rawValue = process.env[LOGIN_ENCRYPTION_KEY_ENV],
) {
  const value = rawValue?.trim()
  if (!value) {
    throw new LoginSharingUnavailableError()
  }

  const key = Buffer.from(value, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new LoginSharingUnavailableError(
      `${LOGIN_ENCRYPTION_KEY_ENV} must decode to ${KEY_BYTES} bytes.`,
    )
  }

  return key
}

export function encryptSharedLogin(
  plaintext: string,
  associatedData: string,
  key = loadLoginEncryptionKey(),
) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(associatedData, 'utf8'))

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])

  return {
    ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64url',
    ),
    keyVersion: LOGIN_ENCRYPTION_KEY_VERSION,
  }
}

export function decryptSharedLogin(
  ciphertext: string,
  associatedData: string,
  keyVersion: number,
  key = loadLoginEncryptionKey(),
) {
  if (keyVersion !== LOGIN_ENCRYPTION_KEY_VERSION) {
    throw new Error(
      `Stored login uses encryption key version ${keyVersion}, which this server cannot open.`,
    )
  }

  const payload = Buffer.from(ciphertext, 'base64url')
  if (payload.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('Stored login ciphertext is malformed.')
  }

  const iv = payload.subarray(0, IV_BYTES)
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const encrypted = payload.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAAD(Buffer.from(associatedData, 'utf8'))
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf8',
  )
}
