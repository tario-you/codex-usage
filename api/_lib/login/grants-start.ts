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

const startGrantBodySchema = z
  .object({
    accountId: z.uuid().optional(),
    label: z.string().trim().max(120).optional(),
    scope: z.enum(['account', 'pool']).default('account'),
  })
  .refine((body) => body.scope === 'pool' || Boolean(body.accountId), {
    message: 'Pick an account, or ask for a pool command.',
  })

/**
 * Owner creates a single-use login command. A pool command follows every
 * login the owner publishes; an account command is pinned to one login.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const body = startGrantBodySchema.parse(await request.json().catch(() => null))
    let accountId: string | null = null

    if (body.scope === 'pool') {
      const { count, error } = await serviceRoleSupabase
        .from('codex_login_secrets')
        .select('account_id', { count: 'exact', head: true })
        .eq('owner_user_id', user.id)

      if (error) {
        throw error
      }

      if (!count) {
        return errorResponse(
          'Publish at least one login from its paired machine first (publish-login).',
          409,
        )
      }
    } else {
      const account = await findOwnedAccountById(user.id, body.accountId ?? '')
      if (!account) {
        return errorResponse('Account not found.', 404)
      }

      if (!(await findSecretByAccountId(account.id))) {
        return errorResponse(
          'Publish this login from its paired machine first (publish-login).',
          409,
        )
      }

      accountId = account.id
    }

    const claimToken = createOpaqueToken()
    const expiresAt = new Date(Date.now() + SHARED_LOGIN_GRANT_TTL_MS).toISOString()
    const origin = getPreferredDashboardOrigin(new URL(request.url).origin)
    const claimUrl = `${origin}/api/login/claim?token=${encodeURIComponent(claimToken)}`

    const { data: grant, error } = await serviceRoleSupabase
      .from('codex_login_grants')
      .insert({
        account_id: accountId,
        claim_token_hash: hashToken(claimToken),
        claim_token_preview: claimToken.slice(0, 8),
        expires_at: expiresAt,
        label: body.label || null,
        owner_user_id: user.id,
        scope: body.scope,
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
