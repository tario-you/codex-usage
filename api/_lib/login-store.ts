import { z } from 'zod'

import type { Database } from '../../src/lib/database.types.js'
import { InvalidSessionError } from './auth.js'
import { errorResponse } from './http.js'
import {
  LoginSharingUnavailableError,
  decryptSharedLogin,
  encryptSharedLogin,
} from './login-crypto.js'
import {
  accountKeyForEmail,
  fingerprintSharedLogin,
  parseSharedLoginFile,
  type SharedLoginFile,
  type SharedLoginIdentity,
} from './login-file.js'
import {
  SharedLoginError,
  reconcileSharedLogin as reconcileSharedLoginGeneration,
  type ReconcileResult as ReconcileGenerationResult,
} from './login-reconcile.js'
import { hashToken } from './security.js'
import { serviceRoleSupabase } from './supabase.js'

export type LoginSecretRow =
  Database['public']['Tables']['codex_login_secrets']['Row']
export type LoginGrantRow =
  Database['public']['Tables']['codex_login_grants']['Row']
type DeviceRow = Database['public']['Tables']['codex_devices']['Row']

export const SHARED_LOGIN_SYNC_POLL_MS = 60_000
export const SHARED_LOGIN_GRANT_TTL_MS = 24 * 60 * 60 * 1000

export const sharedLoginDeviceSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    machineName: z.string().max(200).nullable().optional(),
  })
  .optional()

export async function findActiveDeviceByToken(deviceToken: string) {
  const { data, error } = await serviceRoleSupabase
    .from('codex_devices')
    .select('*')
    .eq('device_token_hash', hashToken(deviceToken))
    .is('revoked_at', null)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data as DeviceRow | null
}

const ownedAccountColumns = 'id, account_key, email, plan_type, source_label'

export async function findOwnedAccountById(ownerUserId: string, accountId: string) {
  const { data, error } = await serviceRoleSupabase
    .from('codex_accounts')
    .select(ownedAccountColumns)
    .eq('id', accountId)
    .eq('owner_user_id', ownerUserId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

export async function findOwnedAccountByEmail(ownerUserId: string, email: string) {
  const { data, error } = await serviceRoleSupabase
    .from('codex_accounts')
    .select(ownedAccountColumns)
    .eq('owner_user_id', ownerUserId)
    .eq('account_key', accountKeyForEmail(email))
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

/** An accepted, unrevoked dashboard invite from owner to viewer. */
export async function findActiveShare(ownerUserId: string, viewerUserId: string) {
  const { data, error } = await serviceRoleSupabase
    .from('codex_dashboard_shares')
    .select('id')
    .eq('owner_user_id', ownerUserId)
    .eq('viewer_user_id', viewerUserId)
    .is('revoked_at', null)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

export async function findSecretByAccountId(accountId: string) {
  const { data, error } = await serviceRoleSupabase
    .from('codex_login_secrets')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

export function openSecret(secret: LoginSecretRow) {
  return parseSharedLoginFile(
    JSON.parse(
      decryptSharedLogin(secret.ciphertext, secret.account_id, secret.key_version),
    ),
  )
}

interface StoreSecretInput {
  accountId: string
  deviceId: string | null
  file: SharedLoginFile
  identity: SharedLoginIdentity
  ownerUserId: string
}

export async function storeSecret({
  accountId,
  deviceId,
  file,
  identity,
  ownerUserId,
}: StoreSecretInput) {
  const encrypted = encryptSharedLogin(JSON.stringify(file), accountId)
  const { data, error } = await serviceRoleSupabase
    .from('codex_login_secrets')
    .upsert(
      {
        account_email: identity.email,
        account_id: accountId,
        auth_mode: file.auth_mode?.toLowerCase() ?? 'chatgpt',
        ciphertext: encrypted.ciphertext,
        device_id: deviceId,
        fingerprint: fingerprintSharedLogin(file),
        key_version: encrypted.keyVersion,
        owner_user_id: ownerUserId,
        plan_type: identity.planType,
        token_expires_at: identity.expiresAt,
        token_issued_at: identity.issuedAt,
      },
      { onConflict: 'account_id' },
    )
    .select('*')
    .single()

  if (error || !data) {
    throw error ?? new Error('Unable to store the shared login.')
  }

  return data
}

export { SharedLoginError }

export type ReconcileResult = ReconcileGenerationResult<LoginSecretRow>

interface ReconcileInput {
  clientFile: SharedLoginFile | null
  clientFingerprint: string | null
  secret: LoginSecretRow | null
  store: (file: SharedLoginFile, identity: SharedLoginIdentity) => Promise<LoginSecretRow>
}

export function reconcileSharedLogin(input: ReconcileInput) {
  return reconcileSharedLoginGeneration<LoginSecretRow>({ ...input, open: openSecret })
}

export async function findActiveGrantByAccessToken(accessToken: string) {
  const { data, error } = await serviceRoleSupabase
    .from('codex_login_grants')
    .select('*')
    .eq('access_token_hash', hashToken(accessToken))
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data || data.status !== 'active' || data.revoked_at) {
    return null
  }

  return data
}

export async function revokeGrantsForAccount(accountId: string) {
  const { error } = await serviceRoleSupabase
    .from('codex_login_grants')
    .update({ revoked_at: new Date().toISOString(), status: 'revoked' })
    .eq('account_id', accountId)
    .eq('scope', 'account')
    .in('status', ['pending', 'active'])

  if (error) {
    throw error
  }
}

export async function listSharesForOwner(ownerUserId: string) {
  const [secretsResult, grantsResult, sharedPools] = await Promise.all([
    serviceRoleSupabase
      .from('codex_login_secrets')
      .select('*')
      .eq('owner_user_id', ownerUserId)
      .order('published_at', { ascending: true }),
    serviceRoleSupabase
      .from('codex_login_grants')
      .select('*')
      .eq('owner_user_id', ownerUserId)
      .order('created_at', { ascending: false }),
    listPoolsSharedWith(ownerUserId),
  ])

  if (secretsResult.error) {
    throw secretsResult.error
  }

  if (grantsResult.error) {
    throw grantsResult.error
  }

  const secrets = secretsResult.data ?? []
  const grants = grantsResult.data ?? []
  const accountIds = [
    ...new Set(
      [
        ...secrets.map((secret) => secret.account_id),
        ...grants.flatMap((grant) => [grant.account_id, grant.current_account_id]),
      ].filter((id): id is string => Boolean(id)),
    ),
  ]
  const accountsById = new Map<
    string,
    { id: string; email: string | null; plan_type: string | null; source_label: string | null }
  >()

  if (accountIds.length > 0) {
    const { data: accounts, error } = await serviceRoleSupabase
      .from('codex_accounts')
      .select('id, email, plan_type, source_label')
      .in('id', accountIds)

    if (error) {
      throw error
    }

    for (const account of accounts ?? []) {
      accountsById.set(account.id, account)
    }
  }

  return {
    grants: grants.map((grant) => ({
      ...serializeGrant(grant),
      currentEmail: grant.current_account_id
        ? accountsById.get(grant.current_account_id)?.email ?? null
        : null,
    })),
    sharedPools,
    publications: secrets.map((secret) => ({
      accountId: secret.account_id,
      deviceLabel: accountsById.get(secret.account_id)?.source_label ?? null,
      email: secret.account_email,
      planType:
        secret.plan_type ?? accountsById.get(secret.account_id)?.plan_type ?? null,
      publishedAt: secret.published_at,
      tokenExpiresAt: secret.token_expires_at,
      tokenIssuedAt: secret.token_issued_at,
      updatedAt: secret.updated_at,
    })),
  }
}

/**
 * Pools other people share with this viewer: every inviter with an accepted,
 * unrevoked dashboard share, how many logins they publish, and the pool
 * commands this viewer already created there.
 */
async function listPoolsSharedWith(viewerUserId: string) {
  const { data: shares, error: sharesError } = await serviceRoleSupabase
    .from('codex_dashboard_shares')
    .select('owner_user_id, created_at')
    .eq('viewer_user_id', viewerUserId)
    .is('revoked_at', null)
    .order('created_at', { ascending: true })

  if (sharesError) {
    throw sharesError
  }

  const ownerIds = [...new Set((shares ?? []).map((share) => share.owner_user_id))]
  if (ownerIds.length === 0) {
    return []
  }

  const [secretsResult, grantsResult, owners] = await Promise.all([
    serviceRoleSupabase
      .from('codex_login_secrets')
      .select('account_id, owner_user_id')
      .in('owner_user_id', ownerIds),
    serviceRoleSupabase
      .from('codex_login_grants')
      .select('*')
      .eq('created_by_user_id', viewerUserId)
      .in('owner_user_id', ownerIds)
      .order('created_at', { ascending: false }),
    Promise.all(
      ownerIds.map(async (ownerId) => {
        const { data } = await serviceRoleSupabase.auth.admin.getUserById(ownerId)
        return [ownerId, data.user] as const
      }),
    ),
  ])

  if (secretsResult.error) {
    throw secretsResult.error
  }

  if (grantsResult.error) {
    throw grantsResult.error
  }

  const secretAccountIds = new Set((secretsResult.data ?? []).map((row) => row.account_id))
  const grantAccountIds = [
    ...new Set(
      (grantsResult.data ?? [])
        .map((grant) => grant.current_account_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const emailsByAccountId = new Map<string, string | null>()
  if (grantAccountIds.length > 0) {
    const { data: accounts, error } = await serviceRoleSupabase
      .from('codex_accounts')
      .select('id, email')
      .in('id', grantAccountIds)

    if (error) {
      throw error
    }

    for (const account of accounts ?? []) {
      emailsByAccountId.set(account.id, account.email)
    }
  }

  const planCounts = new Map<string, number>()
  for (const row of secretsResult.data ?? []) {
    if (secretAccountIds.has(row.account_id)) {
      planCounts.set(row.owner_user_id, (planCounts.get(row.owner_user_id) ?? 0) + 1)
    }
  }

  return ownerIds.map((ownerId) => {
    const owner = owners.find(([id]) => id === ownerId)?.[1] ?? null
    const metadata = (owner?.user_metadata ?? {}) as Record<string, unknown>

    return {
      grants: (grantsResult.data ?? [])
        .filter((grant) => grant.owner_user_id === ownerId)
        .map((grant) => ({
          ...serializeGrant(grant),
          currentEmail: grant.current_account_id
            ? emailsByAccountId.get(grant.current_account_id) ?? null
            : null,
        })),
      inviter: {
        avatarUrl:
          (typeof metadata.avatar_url === 'string' && metadata.avatar_url) ||
          (typeof metadata.picture === 'string' && metadata.picture) ||
          null,
        displayName:
          (typeof metadata.full_name === 'string' && metadata.full_name) ||
          (typeof metadata.name === 'string' && metadata.name) ||
          owner?.email ||
          'Unknown inviter',
        email: owner?.email ?? null,
      },
      ownerUserId: ownerId,
      planCount: planCounts.get(ownerId) ?? 0,
    }
  })
}

export function serializeGrant(grant: LoginGrantRow) {
  return {
    accountId: grant.account_id,
    createdByUserId: grant.created_by_user_id,
    currentAccountId: grant.current_account_id,
    scope: grant.scope,
    switchCount: grant.switch_count,
    switchedAt: grant.switched_at,
    claimTokenPreview: grant.claim_token_preview,
    claimedAt: grant.claimed_at,
    claimedLabel: grant.claimed_label,
    claimedMachineName: grant.claimed_machine_name,
    createdAt: grant.created_at,
    expiresAt: grant.expires_at,
    id: grant.id,
    label: grant.label,
    lastPushedAt: grant.last_pushed_at,
    lastSyncedAt: grant.last_synced_at,
    revokedAt: grant.revoked_at,
    status: effectiveGrantStatus(grant),
    syncCount: grant.sync_count,
  }
}

export function effectiveGrantStatus(grant: LoginGrantRow) {
  if (grant.status === 'pending' && Date.parse(grant.expires_at) <= Date.now()) {
    return 'expired'
  }

  return grant.status
}

export function serializeSharedLoginAccount(identity: SharedLoginIdentity) {
  return {
    accountId: identity.accountId,
    email: identity.email,
    planType: identity.planType,
  }
}

export function sharedLoginErrorResponse(error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    return errorResponse(error.issues.map((issue) => issue.message).join('; '))
  }

  if (error instanceof SharedLoginError) {
    return errorResponse(error.message, error.status)
  }

  if (error instanceof LoginSharingUnavailableError) {
    return errorResponse(error.message, 503)
  }

  if (error instanceof InvalidSessionError) {
    return errorResponse(error.message, 401)
  }

  return errorResponse(error instanceof Error ? error.message : fallback, 400)
}
