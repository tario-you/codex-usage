import { createHash } from 'node:crypto'

import { z } from 'zod'

const sharedLoginTokensSchema = z
  .object({
    access_token: z.string().min(1),
    account_id: z.string().min(1),
    id_token: z.string().min(1),
    refresh_token: z.string().min(1),
  })
  .passthrough()

export const sharedLoginFileSchema = z
  .object({
    OPENAI_API_KEY: z.string().nullable().optional(),
    auth_mode: z.string().nullable().optional(),
    last_refresh: z.string().min(1),
    tokens: sharedLoginTokensSchema,
  })
  .passthrough()

export type SharedLoginFile = z.infer<typeof sharedLoginFileSchema>

export interface SharedLoginIdentity {
  accountId: string
  email: string
  expiresAt: string | null
  issuedAt: string
  planType: string | null
}

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile'

export function parseSharedLoginFile(value: unknown): SharedLoginFile {
  const file = sharedLoginFileSchema.parse(value)

  if (file.OPENAI_API_KEY) {
    throw new Error(
      'That Codex login uses an API key. Only ChatGPT plan logins can be shared.',
    )
  }

  if (file.auth_mode && file.auth_mode.toLowerCase() !== 'chatgpt') {
    throw new Error(
      `That Codex login uses auth mode "${file.auth_mode}". Only ChatGPT plan logins can be shared.`,
    )
  }

  return file
}

export function fingerprintSharedLogin(file: SharedLoginFile) {
  return createHash('sha256')
    .update(
      [
        file.tokens.id_token,
        file.tokens.access_token,
        file.tokens.refresh_token,
        file.tokens.account_id,
      ].join('\n'),
    )
    .digest('hex')
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split('.')
  if (segments.length < 2) {
    return null
  }

  try {
    const payload = JSON.parse(
      Buffer.from(segments[1], 'base64url').toString('utf8'),
    ) as unknown

    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function describeSharedLogin(file: SharedLoginFile): SharedLoginIdentity {
  const accessClaims = decodeJwtPayload(file.tokens.access_token)
  const idClaims = decodeJwtPayload(file.tokens.id_token)
  const accessAuth = getClaimObject(accessClaims, OPENAI_AUTH_CLAIM)
  const accessProfile = getClaimObject(accessClaims, OPENAI_PROFILE_CLAIM)
  const idAuth = getClaimObject(idClaims, OPENAI_AUTH_CLAIM)

  const email = firstString([
    accessProfile?.email,
    idClaims?.email,
  ])?.toLowerCase()
  const issuedAtSeconds = firstNumber([accessClaims?.iat, idClaims?.iat])

  if (!email) {
    throw new Error('That Codex login does not carry an account email.')
  }

  if (issuedAtSeconds == null) {
    throw new Error('That Codex login does not carry a token issue time.')
  }

  const expiresAtSeconds = firstNumber([accessClaims?.exp])

  return {
    accountId:
      firstString([
        file.tokens.account_id,
        accessAuth?.chatgpt_account_id,
        idAuth?.chatgpt_account_id,
      ]) ?? file.tokens.account_id,
    email,
    expiresAt:
      expiresAtSeconds == null
        ? null
        : new Date(expiresAtSeconds * 1000).toISOString(),
    issuedAt: new Date(issuedAtSeconds * 1000).toISOString(),
    planType:
      firstString([accessAuth?.chatgpt_plan_type, idAuth?.chatgpt_plan_type]) ??
      null,
  }
}

export function accountKeyForEmail(email: string) {
  return `chatgpt:${email.toLowerCase()}`
}

function getClaimObject(
  claims: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const value = claims?.[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstString(values: unknown[]) {
  return values.find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
}

function firstNumber(values: unknown[]) {
  return values.find(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value),
  )
}
