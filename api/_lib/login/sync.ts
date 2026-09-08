import { z } from 'zod'

import { errorResponse, jsonResponse } from '../http.js'
import {
  describeSharedLogin,
  parseSharedLoginFile,
  sharedLoginFileSchema,
} from '../login-file.js'
import {
  SHARED_LOGIN_SYNC_POLL_MS,
  SharedLoginError,
  findActiveDeviceByToken,
  findActiveGrantByAccessToken,
  findOwnedAccountByEmail,
  findSecretByAccountId,
  reconcileSharedLogin,
  sharedLoginErrorResponse,
  storeSecret,
  type LoginSecretRow,
} from '../login-store.js'
import { serviceRoleSupabase } from '../supabase.js'

const syncBodySchema = z
  .object({
    accessToken: z.string().min(1).optional(),
    authFile: sharedLoginFileSchema.optional(),
    deviceToken: z.string().min(1).optional(),
    email: z.string().email().optional(),
    fingerprint: z.string().min(1).optional(),
  })
  .refine((body) => Boolean(body.accessToken) !== Boolean(body.deviceToken), {
    message: 'Send either a device token (owner) or an access token (recipient).',
  })

/**
 * Two-way keep-fresh for a shared login. Both the owner's source machine
 * (device token) and every recipient (grant access token) call this on a
 * timer. Whoever holds the newest token generation wins; everyone else pulls.
 */
export async function POST(request: Request) {
  try {
    const body = syncBodySchema.parse(await request.json().catch(() => null))
    const clientFile = body.authFile ? parseSharedLoginFile(body.authFile) : null
    const nowIso = new Date().toISOString()

    if (body.deviceToken) {
      const device = await findActiveDeviceByToken(body.deviceToken)
      if (!device) {
        return errorResponse('This device is no longer authorized.', 401)
      }

      const email = clientFile ? describeSharedLogin(clientFile).email : body.email
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
        clientFingerprint: body.fingerprint ?? null,
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

      return jsonResponse(serializeSyncResult(result, email, secret))
    }

    const grant = await findActiveGrantByAccessToken(body.accessToken ?? '')
    if (!grant) {
      return errorResponse('This shared login was revoked.', 401)
    }

    const secret = await findSecretByAccountId(grant.account_id)
    if (!secret) {
      await serviceRoleSupabase
        .from('codex_login_grants')
        .update({ revoked_at: nowIso, status: 'revoked' })
        .eq('id', grant.id)

      throw new SharedLoginError('This login is no longer shared.', 410)
    }

    const result = await reconcileSharedLogin({
      clientFile,
      clientFingerprint: body.fingerprint ?? null,
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

    const { error: touchError } = await serviceRoleSupabase
      .from('codex_login_grants')
      .update({
        last_synced_at: nowIso,
        sync_count: grant.sync_count + 1,
        ...(result.outcome === 'stored' ? { last_pushed_at: nowIso } : {}),
      })
      .eq('id', grant.id)

    if (touchError) {
      throw touchError
    }

    return jsonResponse(serializeSyncResult(result, secret.account_email, secret))
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to sync this login.')
  }
}

function serializeSyncResult(
  result: Awaited<ReturnType<typeof reconcileSharedLogin>>,
  email: string,
  secret: LoginSecretRow,
) {
  return {
    account: {
      accountId: result.secret.account_id,
      email,
      planType: result.secret.plan_type ?? secret.plan_type,
    },
    authFile: result.file,
    fingerprint: result.fingerprint,
    issuedAt: result.issuedAt,
    ok: true,
    outcome: result.outcome,
    pollMs: SHARED_LOGIN_SYNC_POLL_MS,
  }
}
