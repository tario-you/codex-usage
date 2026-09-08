import {
  describeSharedLogin,
  fingerprintSharedLogin,
  type SharedLoginFile,
  type SharedLoginIdentity,
} from './login-file.js'

export class SharedLoginError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'SharedLoginError'
    this.status = status
  }
}

export interface StoredLoginGeneration {
  account_id: string
  fingerprint: string
  token_issued_at: string
}

export interface ReconcileResult<Secret extends StoredLoginGeneration> {
  file: SharedLoginFile | null
  fingerprint: string
  issuedAt: string
  outcome: 'pull' | 'stored' | 'unchanged'
  secret: Secret
}

interface ReconcileInput<Secret extends StoredLoginGeneration> {
  clientFile: SharedLoginFile | null
  clientFingerprint: string | null
  open: (secret: Secret) => SharedLoginFile
  secret: Secret | null
  store: (file: SharedLoginFile, identity: SharedLoginIdentity) => Promise<Secret>
}

/**
 * Newest token generation wins. A generation is ordered by the access token's
 * issue time, never by `last_refresh`, because a recipient's local copy carries
 * a deliberately shifted `last_refresh` (see bin/lib/login-file.js).
 *
 * This module has no database or environment imports so it can be unit tested
 * and reasoned about on its own.
 */
export async function reconcileSharedLogin<Secret extends StoredLoginGeneration>({
  clientFile,
  clientFingerprint,
  open,
  secret,
  store,
}: ReconcileInput<Secret>): Promise<ReconcileResult<Secret>> {
  if (clientFile) {
    const identity = describeSharedLogin(clientFile)
    const fingerprint = fingerprintSharedLogin(clientFile)
    const clientIssuedAt = Date.parse(identity.issuedAt)
    const storedIssuedAt = secret ? Date.parse(secret.token_issued_at) : Number.NaN

    if (!secret || clientIssuedAt > storedIssuedAt) {
      const stored = await store(clientFile, identity)
      return {
        file: null,
        fingerprint,
        issuedAt: identity.issuedAt,
        outcome: 'stored',
        secret: stored,
      }
    }

    if (fingerprint === secret.fingerprint) {
      return {
        file: null,
        fingerprint,
        issuedAt: secret.token_issued_at,
        outcome: 'unchanged',
        secret,
      }
    }

    return {
      file: open(secret),
      fingerprint: secret.fingerprint,
      issuedAt: secret.token_issued_at,
      outcome: 'pull',
      secret,
    }
  }

  if (!secret) {
    throw new SharedLoginError('This login is no longer shared.', 410)
  }

  if (clientFingerprint && clientFingerprint === secret.fingerprint) {
    return {
      file: null,
      fingerprint: secret.fingerprint,
      issuedAt: secret.token_issued_at,
      outcome: 'unchanged',
      secret,
    }
  }

  return {
    file: open(secret),
    fingerprint: secret.fingerprint,
    issuedAt: secret.token_issued_at,
    outcome: 'pull',
    secret,
  }
}
