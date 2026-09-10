import { z } from 'zod'
import { recordSwitchEvents } from '../switch-store.js'

import type { CodexRateLimitsResponse } from '../../../src/shared/codex.js'
import { errorResponse, jsonResponse } from '../http.js'
import {
  describeSharedLogin,
  parseSharedLoginFile,
  sharedLoginFileSchema,
  type SharedLoginFile,
} from '../login-file.js'
import {
  chooseNextAccount,
  loadPoolAccounts,
  persistGrantRateLimits,
  serializePoolDecision,
} from '../login-pool.js'
import {
  SHARED_LOGIN_SYNC_POLL_MS,
  SharedLoginError,
  findActiveDeviceByToken,
  findActiveGrantByAccessToken,
  findOwnedAccountByEmail,
  findSecretByAccountId,
  openSecret,
  reconcileSharedLogin,
  sharedLoginErrorResponse,
  storeSecret,
  type LoginGrantRow,
  type LoginSecretRow,
} from '../login-store.js'
import { rateLimitsSchema } from '../schemas.js'
import { serviceRoleSupabase } from '../supabase.js'

const syncBodySchema = z
  .object({
    accessToken: z.string().min(1).optional(),
    authFile: sharedLoginFileSchema.optional(),
    deviceToken: z.string().min(1).optional(),
    email: z.string().email().optional(),
    fingerprint: z.string().min(1).optional(),
    rateLimits: rateLimitsSchema.optional(),
  })
  .refine((body) => Boolean(body.accessToken) !== Boolean(body.deviceToken), {
    message: 'Send either a device token (owner) or an access token (recipient).',
  })

/**
 * Two-way keep-fresh for a shared login. Both the owner's source machine
 * (device token) and every recipient (grant access token) call this on a
 * timer. Whoever holds the newest token generation wins; everyone else pulls.
 * Pool recipients also report their rate limits and are moved to the next
 * usable account once the current one is exhausted.
 */
export async function POST(request: Request) {
  try {
    const body = syncBodySchema.parse(await request.json().catch(() => null))
    const clientFile = body.authFile ? parseSharedLoginFile(body.authFile) : null

    if (body.deviceToken) {
      return await syncForOwner(body.deviceToken, clientFile, body.fingerprint ?? null, body.email)
    }

    return await syncForRecipient(
      body.accessToken ?? '',
      clientFile,
      body.fingerprint ?? null,
      body.rateLimits as CodexRateLimitsResponse | undefined,
      body.email ?? null,
    )
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to sync this login.')
  }
}

async function syncForOwner(
  deviceToken: string,
  clientFile: SharedLoginFile | null,
  clientFingerprint: string | null,
  bodyEmail: string | undefined,
) {
  const device = await findActiveDeviceByToken(deviceToken)
  if (!device) {
    return errorResponse('This device is no longer authorized.', 401)
  }

  const email = clientFile ? describeSharedLogin(clientFile).email : bodyEmail
  if (!email) {
    return errorResponse('Send the auth file or the account email.', 400)
  }

  const account = await findOwnedAccountByEmail(device.owner_user_id, email)
  const secret = account ? await findSecretByAccountId(account.id) : null
  if (!account || !secret) {
    throw new SharedLoginError(
      `${email} is not a shared login. Run publish-login first.`,
      404,
    )
  }

  const result = await reconcileSharedLogin({
    clientFile,
    clientFingerprint,
    secret,
    store: (file, identity) =>
      storeSecret({
        accountId: account.id,
        deviceId: device.id,
        file,
        identity,
        ownerUserId: device.owner_user_id,
      }),
  })

  return jsonResponse({
    account: {
      accountId: result.secret.account_id,
      email,
      planType: result.secret.plan_type,
    },
    authFile: result.file,
    fingerprint: result.fingerprint,
    issuedAt: result.issuedAt,
    ok: true,
    outcome: result.outcome,
    pollMs: SHARED_LOGIN_SYNC_POLL_MS,
  })
}

async function syncForRecipient(
  accessToken: string,
  clientFile: SharedLoginFile | null,
  clientFingerprint: string | null,
  rateLimits: CodexRateLimitsResponse | undefined,
  localEmailHint: string | null,
) {
  const grant = await findActiveGrantByAccessToken(accessToken)
  if (!grant) {
    return errorResponse('This shared login was revoked.', 401)
  }

  const nowIso = new Date().toISOString()
  let currentAccountId = grant.current_account_id ?? grant.account_id
  let currentSecret = currentAccountId ? await findSecretByAccountId(currentAccountId) : null
  let fileForReconcile = clientFile

  // The recipient's local file decides which account it is really on. A file
  // for an account outside this grant is never pushed anywhere.
  const localEmail = clientFile
    ? describeSharedLogin(clientFile).email
    : localEmailHint?.toLowerCase() ?? null
  if (localEmail && currentSecret?.account_email !== localEmail) {
    const matching = await findSecretForGrantByEmail(grant, localEmail)
    if (matching) {
      currentSecret = matching
      currentAccountId = matching.account_id
    } else {
      fileForReconcile = null
    }
  }

  if (rateLimits && currentAccountId) {
    await persistGrantRateLimits({ accountId: currentAccountId, grantId: grant.id, rateLimits })
  }

  let pool: ReturnType<typeof serializePoolDecision> | null = null
  if (grant.scope === 'pool') {
    const { accounts, secretsByAccountId } = await loadPoolAccounts(grant.owner_user_id)
    const decision = chooseNextAccount({ accounts, currentAccountId })
    pool = serializePoolDecision(decision)
    const target = decision.accountId ? secretsByAccountId.get(decision.accountId) ?? null : null

    if (target && target.account_id !== currentAccountId) {
      await touchGrant(grant, {
        current_account_id: target.account_id,
        last_synced_at: nowIso,
        switch_count: grant.switch_count + 1,
        switched_at: nowIso,
        sync_count: grant.sync_count + 1,
      })
      // The recipient's switch joins the owner's history (#switch-history).
      try {
        await recordSwitchEvents([{
          ownerUserId: grant.owner_user_id,
          source: 'grant',
          grantId: grant.id,
          kind: 'switched',
          fromEmail: currentSecret?.account_email ?? null,
          toEmail: target.account_email,
          reason: decision.reason,
          occurredAt: nowIso,
        }])
      } catch {
        // History is a record, never a reason to withhold the login.
      }

      return jsonResponse({
        account: {
          accountId: target.account_id,
          email: target.account_email,
          planType: target.plan_type,
        },
        authFile: openSecret(target),
        fingerprint: target.fingerprint,
        issuedAt: target.token_issued_at,
        ok: true,
        outcome: 'switch',
        pollMs: SHARED_LOGIN_SYNC_POLL_MS,
        pool,
      })
    }

    if (!currentSecret && target) {
      currentSecret = target
      currentAccountId = target.account_id
    }
  }

  if (!currentSecret) {
    await touchGrant(grant, { revoked_at: nowIso, status: 'revoked' })
    throw new SharedLoginError('This login is no longer shared.', 410)
  }

  const secret: LoginSecretRow = currentSecret
  const result = await reconcileSharedLogin({
    clientFile: fileForReconcile,
    clientFingerprint,
    secret,
    store: (file, identity) =>
      storeSecret({
        accountId: secret.account_id,
        deviceId: secret.device_id,
        file,
        identity,
        ownerUserId: secret.owner_user_id,
      }),
  })

  await touchGrant(grant, {
    current_account_id: secret.account_id,
    last_synced_at: nowIso,
    sync_count: grant.sync_count + 1,
    ...(result.outcome === 'stored' ? { last_pushed_at: nowIso } : {}),
  })

  return jsonResponse({
    account: {
      accountId: result.secret.account_id,
      email: secret.account_email,
      planType: result.secret.plan_type ?? secret.plan_type,
    },
    authFile: result.file,
    fingerprint: result.fingerprint,
    issuedAt: result.issuedAt,
    ok: true,
    outcome: result.outcome,
    pollMs: SHARED_LOGIN_SYNC_POLL_MS,
    pool,
  })
}

async function findSecretForGrantByEmail(grant: LoginGrantRow, email: string) {
  if (grant.scope !== 'pool') {
    const secret = grant.account_id ? await findSecretByAccountId(grant.account_id) : null
    return secret?.account_email === email ? secret : null
  }

  const { data, error } = await serviceRoleSupabase
    .from('codex_login_secrets')
    .select('*')
    .eq('owner_user_id', grant.owner_user_id)
    .eq('account_email', email)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

async function touchGrant(
  grant: LoginGrantRow,
  values: Partial<LoginGrantRow>,
) {
  const { error } = await serviceRoleSupabase
    .from('codex_login_grants')
    .update(values)
    .eq('id', grant.id)

  if (error) {
    throw error
  }
}
