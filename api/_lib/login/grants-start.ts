import { z } from 'zod'

import { buildUseLoginCommand } from '../../../src/shared/cli.js'
import { getPreferredDashboardOrigin } from '../../../src/shared/site.js'
import { requireUser } from '../auth.js'
import { errorResponse, jsonResponse } from '../http.js'
import {
  SHARED_LOGIN_GRANT_TTL_MS,
  findOwnedAccountById,
  findSecretByAccountId,
  serializeGrant,
  sharedLoginErrorResponse,
} from '../login-store.js'
import { createOpaqueToken, hashToken } from '../security.js'
import { serviceRoleSupabase } from '../supabase.js'

const startGrantBodySchema = z.object({
  accountId: z.uuid(),
  label: z.string().trim().max(120).optional(),
})

/** Owner creates a single-use login command for one published account. */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const body = startGrantBodySchema.parse(await request.json().catch(() => null))
    const account = await findOwnedAccountById(user.id, body.accountId)

    if (!account) {
      return errorResponse('Account not found.', 404)
    }

    const secret = await findSecretByAccountId(account.id)
    if (!secret) {
      return errorResponse(
        'Publish this login from its paired machine first (publish-login).',
        409,
      )
    }

    const claimToken = createOpaqueToken()
    const expiresAt = new Date(Date.now() + SHARED_LOGIN_GRANT_TTL_MS).toISOString()
    const origin = getPreferredDashboardOrigin(new URL(request.url).origin)
    const claimUrl = `${origin}/api/login/claim?token=${encodeURIComponent(claimToken)}`

    const { data: grant, error } = await serviceRoleSupabase
      .from('codex_login_grants')
      .insert({
        account_id: account.id,
        claim_token_hash: hashToken(claimToken),
        claim_token_preview: claimToken.slice(0, 8),
        expires_at: expiresAt,
        label: body.label || null,
        owner_user_id: user.id,
      })
      .select('*')
      .single()

    if (error || !grant) {
      throw error ?? new Error('Unable to create the login command.')
    }

    return jsonResponse({
      claimUrl,
      command: buildUseLoginCommand(claimUrl),
      expiresAt,
      grant: serializeGrant(grant),
    })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to create the login command.')
  }
}
