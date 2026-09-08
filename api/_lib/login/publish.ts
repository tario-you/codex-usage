import { z } from 'zod'

import type {
  CodexAccountReadResponse,
  CodexRateLimitsResponse,
} from '../../../src/shared/codex.js'
import { errorResponse, jsonResponse } from '../http.js'
import {
  accountKeyForEmail,
  describeSharedLogin,
  parseSharedLoginFile,
  sharedLoginFileSchema,
  type SharedLoginIdentity,
} from '../login-file.js'
import {
  SHARED_LOGIN_SYNC_POLL_MS,
  findActiveDeviceByToken,
  findOwnedAccountByEmail,
  findSecretByAccountId,
  reconcileSharedLogin,
  serializeSharedLoginAccount,
  sharedLoginErrorResponse,
  storeSecret,
} from '../login-store.js'
import { persistSnapshotForOwner } from '../persistence.js'
import {
  accountStateSchema,
  deviceMetadataSchema,
  rateLimitsSchema,
} from '../schemas.js'
import { serviceRoleSupabase } from '../supabase.js'

const publishBodySchema = z.object({
  accountState: accountStateSchema.optional(),
  authFile: sharedLoginFileSchema,
  device: deviceMetadataSchema.optional(),
  deviceToken: z.string().min(1),
  rateLimits: rateLimitsSchema.optional(),
})

/**
 * Owner side. The paired machine sends the Codex login for one of its
 * accounts. When the login is the machine's active Codex account, the CLI also
 * sends a usage snapshot and it is persisted like a normal sync. The account
 * row is created if the dashboard has never seen it. If the server already
 * holds a newer token generation (a recipient refreshed first), that copy is
 * returned instead so the owner's local source can catch up.
 */
export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const body = publishBodySchema.parse(await request.json().catch(() => null))
    const authFile = parseSharedLoginFile(body.authFile)
    const identity = describeSharedLogin(authFile)
    const accountState = body.accountState as CodexAccountReadResponse | undefined
    const rateLimits = body.rateLimits as CodexRateLimitsResponse | undefined

    const device = await findActiveDeviceByToken(body.deviceToken)
    if (!device) {
      return errorResponse('This device is no longer authorized.', 401)
    }

    const deviceContext = {
      codexHome: body.device?.codexHome ?? device.codex_home,
      deviceId: device.id,
      deviceKey: device.device_key,
      label: body.device?.label?.trim() || device.label,
      machineName: body.device?.machineName ?? device.machine_name,
      metadata: device.metadata,
    }

    const snapshotMatchesLogin =
      accountState?.account?.type === 'chatgpt' &&
      accountState.account.email?.toLowerCase() === identity.email

    if (accountState && rateLimits && snapshotMatchesLogin) {
      await persistSnapshotForOwner({
        accountState,
        device: deviceContext,
        ownerUserId: device.owner_user_id,
        rateLimits,
      })
    }

    const account =
      (await findOwnedAccountByEmail(device.owner_user_id, identity.email)) ??
      (await createOwnedAccountForLogin(device.owner_user_id, deviceContext, identity))

    const result = await reconcileSharedLogin({
      clientFile: authFile,
      clientFingerprint: null,
      secret: await findSecretByAccountId(account.id),
      store: (file, fileIdentity) =>
        storeSecret({
          accountId: account.id,
          deviceId: device.id,
          file,
          identity: fileIdentity,
          ownerUserId: device.owner_user_id,
        }),
    })

    return jsonResponse({
      account: serializeSharedLoginAccount(identity),
      authFile: result.file,
      fingerprint: result.fingerprint,
      issuedAt: result.issuedAt,
      ok: true,
      outcome: result.outcome,
      pollMs: SHARED_LOGIN_SYNC_POLL_MS,
      shareUrl: new URL('/', url.origin).toString(),
      syncUrl: `${url.origin}/api/login/sync`,
    })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to publish this login.')
  }
}

async function createOwnedAccountForLogin(
  ownerUserId: string,
  device: { deviceKey: string; label: string; codexHome: string | null },
  identity: SharedLoginIdentity,
) {
  const nowIso = new Date().toISOString()
  const { data, error } = await serviceRoleSupabase
    .from('codex_accounts')
    .insert({
      account_key: accountKeyForEmail(identity.email),
      codex_home: device.codexHome,
      email: identity.email,
      last_seen_at: nowIso,
      metadata: { auth_type: 'chatgpt', onboarding: 'publish-login' },
      owner_user_id: ownerUserId,
      plan_type: identity.planType,
      source_key: device.deviceKey,
      source_label: device.label,
    })
    .select('id, account_key, email, plan_type, source_label')
    .single()

  if (error || !data) {
    throw error ?? new Error('Unable to register the account for this login.')
  }

  return data
}
