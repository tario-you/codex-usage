import { z } from 'zod'

import { buildUseLoginCommand } from '../../../src/shared/cli.js'
import { getPreferredDashboardOrigin } from '../../../src/shared/site.js'
import { requireUser } from '../auth.js'
import { errorResponse, jsonResponse } from '../http.js'
import {
  SHARED_LOGIN_GRANT_TTL_MS,
  findActiveShare,
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
    ownerUserId: z.uuid().optional(),
    scope: z.enum(['account', 'pool']).default('account'),
  })
  .refine((body) => body.scope === 'pool' || Boolean(body.accountId), {
    message: 'Pick an account, or ask for a pool command.',
  })

/**
 * Creates a single-use login command. A pool command follows every login the
 * pool owner publishes; an account command is pinned to one login.
 *
 * The pool owner can create either kind. A dashboard viewer (someone who
 * accepted the owner's invite) can create a pool command on that owner's pool
 * for themselves; the grant still belongs to the owner, who sees and can
 * revoke it, and it records who asked for it.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const body = startGrantBodySchema.parse(await request.json().catch(() => null))
    const poolOwnerId = body.ownerUserId ?? user.id
    const isOwner = poolOwnerId === user.id
    let accountId: string | null = null
    let label = body.label || null

    if (!isOwner) {
      if (body.scope !== 'pool') {
        return errorResponse('Only the pool owner can create a pinned command.', 403)
      }

      if (!(await findActiveShare(poolOwnerId, user.id))) {
        return errorResponse('That dashboard is not shared with you.', 403)
      }

      label = label ?? user.email ?? null
    }

    if (body.scope === 'pool') {
      const { count, error } = await serviceRoleSupabase
        .from('codex_login_secrets')
        .select('account_id', { count: 'exact', head: true })
        .eq('owner_user_id', poolOwnerId)

      if (error) {
        throw error
      }

      if (!count) {
        return errorResponse(
          isOwner
            ? 'Publish at least one login from its paired machine first (publish-login).'
            : 'The inviter has not published any login yet.',
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
        created_by_user_id: user.id,
        expires_at: expiresAt,
        label,
        owner_user_id: poolOwnerId,
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
