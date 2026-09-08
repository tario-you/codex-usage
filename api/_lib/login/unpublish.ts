import { z } from 'zod'

import { requireUser } from '../auth.js'
import { errorResponse, jsonResponse } from '../http.js'
import { describeSharedLogin, parseSharedLoginFile, sharedLoginFileSchema } from '../login-file.js'
import {
  findActiveDeviceByToken,
  findOwnedAccountByEmail,
  findOwnedAccountById,
  revokeGrantsForAccount,
  sharedLoginErrorResponse,
} from '../login-store.js'
import { serviceRoleSupabase } from '../supabase.js'

const unpublishBodySchema = z
  .object({
    accountId: z.uuid().optional(),
    authFile: sharedLoginFileSchema.optional(),
    deviceToken: z.string().min(1).optional(),
    email: z.string().email().optional(),
  })
  .optional()

/**
 * Stop sharing one login. Works from the dashboard (session + accountId) and
 * from the owner's CLI (device token + email or auth file). Deletes the
 * ciphertext and revokes every pending or active grant for that account.
 */
export async function POST(request: Request) {
  try {
    const body = unpublishBodySchema.parse(await request.json().catch(() => null)) ?? {}
    const hasSession = Boolean(request.headers.get('authorization'))
    let ownerUserId: string
    let accountId: string | null = null

    if (hasSession) {
      const user = await requireUser(request)
      ownerUserId = user.id

      if (!body.accountId) {
        return errorResponse('Missing accountId.', 400)
      }

      accountId = (await findOwnedAccountById(ownerUserId, body.accountId))?.id ?? null
    } else {
      if (!body.deviceToken) {
        return errorResponse('Sign in or send a device token.', 401)
      }

      const device = await findActiveDeviceByToken(body.deviceToken)
      if (!device) {
        return errorResponse('This device is no longer authorized.', 401)
      }

      ownerUserId = device.owner_user_id
      const email = body.authFile
        ? describeSharedLogin(parseSharedLoginFile(body.authFile)).email
        : body.email

      if (!email) {
        return errorResponse('Send the auth file or the account email.', 400)
      }

      accountId = (await findOwnedAccountByEmail(ownerUserId, email))?.id ?? null
    }

    if (!accountId) {
      return errorResponse('Account not found.', 404)
    }

    await revokeGrantsForAccount(accountId)

    const { error } = await serviceRoleSupabase
      .from('codex_login_secrets')
      .delete()
      .eq('account_id', accountId)
      .eq('owner_user_id', ownerUserId)

    if (error) {
      throw error
    }

    return jsonResponse({ accountId, ok: true })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to stop sharing this login.')
  }
}
