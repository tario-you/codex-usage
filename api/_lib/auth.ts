import type { User } from '@supabase/supabase-js'
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'

import { serverEnv } from './env.js'

export class InvalidSessionError extends Error {
  constructor(message = 'Your session is no longer valid. Sign in again.') {
    super(message)
    this.name = 'InvalidSessionError'
  }
}

/**
 * Session tokens are verified here, against the project's public signing
 * keys, never by asking Supabase Auth per request. During the 2026-09-10
 * Supabase Auth outage every `auth.getUser` call hung, which took the whole
 * API down for users whose tokens were perfectly valid.
 *
 * The one key source is the project JWKS. Production pins it in
 * `SUPABASE_JWKS` so verification never waits on the network; without that
 * variable the JWKS endpoint is read once and cached in memory.
 */
export const SUPABASE_JWT_AUDIENCE = 'authenticated'

export function supabaseIssuer(supabaseUrl = serverEnv.SUPABASE_URL) {
  return `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`
}

let cachedKeySet: JWTVerifyGetKey | null = null

function resolveKeySet(): JWTVerifyGetKey {
  if (cachedKeySet) return cachedKeySet
  cachedKeySet = serverEnv.SUPABASE_JWKS
    ? createLocalJWKSet(JSON.parse(serverEnv.SUPABASE_JWKS))
    : createRemoteJWKSet(new URL(`${supabaseIssuer()}/.well-known/jwks.json`), {
        timeoutDuration: 5_000,
      })
  return cachedKeySet
}

export function userFromClaims(payload: JWTPayload): User {
  const appMetadata =
    payload.app_metadata && typeof payload.app_metadata === 'object'
      ? (payload.app_metadata as User['app_metadata'])
      : {}
  const userMetadata =
    payload.user_metadata && typeof payload.user_metadata === 'object'
      ? (payload.user_metadata as User['user_metadata'])
      : {}
  return {
    app_metadata: appMetadata,
    aud: SUPABASE_JWT_AUDIENCE,
    created_at: '',
    email: typeof payload.email === 'string' ? payload.email : undefined,
    id: payload.sub as string,
    identities: [],
    is_anonymous: payload.is_anonymous === true,
    role: SUPABASE_JWT_AUDIENCE,
    user_metadata: userMetadata,
  } as User
}

export async function verifyAccessToken(
  accessToken: string,
  options: { issuer?: string; keySet?: JWTVerifyGetKey } = {},
): Promise<User> {
  let payload: JWTPayload
  try {
    ;({ payload } = await jwtVerify(accessToken, options.keySet ?? resolveKeySet(), {
      audience: SUPABASE_JWT_AUDIENCE,
      issuer: options.issuer ?? supabaseIssuer(),
    }))
  } catch {
    throw new InvalidSessionError()
  }
  if (payload.role !== SUPABASE_JWT_AUDIENCE || typeof payload.sub !== 'string' || !payload.sub) {
    throw new InvalidSessionError()
  }
  return userFromClaims(payload)
}

export async function requireUser(request: Request) {
  const authorization = request.headers.get('authorization')
  const accessToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : null

  if (!accessToken) {
    throw new InvalidSessionError('Missing Authorization header.')
  }

  return verifyAccessToken(accessToken)
}

export function hasGoogleIdentity(user: User) {
  if (user.app_metadata?.provider === 'google') {
    return true
  }

  const providers = Array.isArray(user.app_metadata?.providers)
    ? user.app_metadata.providers
    : []
  if (providers.includes('google')) {
    return true
  }

  return (
    user.identities?.some((identity) => identity.provider === 'google') ?? false
  )
}
