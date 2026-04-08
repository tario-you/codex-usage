import { requireUser } from '../_lib/auth.js'
import { errorResponse, jsonResponse } from '../_lib/http.js'
import { createOpaqueToken, hashToken } from '../_lib/security.js'
import { serviceRoleSupabase } from '../_lib/supabase.js'
import { getPreferredDashboardOrigin } from '../../src/shared/site.js'

const SHARE_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const inviteToken = createOpaqueToken()
    const expiresAt = new Date(Date.now() + SHARE_INVITE_TTL_MS).toISOString()
    const origin = getPreferredDashboardOrigin(new URL(request.url).origin)
    const inviteUrl = new URL('/', origin)

    inviteUrl.searchParams.set('invite', inviteToken)

    const { error } = await serviceRoleSupabase
      .from('codex_dashboard_share_invites')
      .insert({
        expires_at: expiresAt,
        invite_token_hash: hashToken(inviteToken),
        invite_token_preview: inviteToken.slice(0, 8),
        owner_user_id: user.id,
      })

    if (error) {
      throw error
    }

    return jsonResponse({
      expiresAt,
      inviteUrl: inviteUrl.toString(),
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to create an invite link.'
    const status = message.includes('Authorization') ? 401 : 400
    return errorResponse(message, status)
  }
}
