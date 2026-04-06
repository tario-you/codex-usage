import { createHash, randomBytes } from 'node:crypto'

export function createOpaqueToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url')
}

export function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
