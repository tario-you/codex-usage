import type { User } from '@supabase/supabase-js'

import { errorResponse, jsonResponse } from '../_lib/http.js'
import { hashToken } from '../_lib/security.js'
import { serviceRoleSupabase } from '../_lib/supabase.js'

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const inviteToken = url.searchParams.get('token')?.trim()

    if (!inviteToken) {
      return errorResponse('Missing invite token.', 400)
    }

    const { data: invite, error: inviteError } = await serviceRoleSupabase
      .from('codex_dashboard_share_invites')
      .select('*')
      .eq('invite_token_hash', hashToken(inviteToken))
      .maybeSingle()

    if (inviteError) {
      throw inviteError
    }

    if (!invite) {
      return errorResponse('This invite link is invalid.', 404)
    }

    const { data: ownerData, error: ownerError } =
      await serviceRoleSupabase.auth.admin.getUserById(invite.owner_user_id)

    if (ownerError || !ownerData.user) {
      throw ownerError ?? new Error('Unable to load inviter details.')
    }

    return jsonResponse({
      expiresAt: invite.expires_at,
      inviter: serializeInviter(ownerData.user),
      status: getInviteStatus(invite.status, invite.expires_at),
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to load invite details.'
    return errorResponse(message, 400)
  }
}

function getInviteStatus(status: string, expiresAt: string) {
  if (status === 'pending' && Date.parse(expiresAt) <= Date.now()) {
    return 'expired'
  }

  return status
}

function serializeInviter(user: User) {
  return {
    avatarUrl:
      getString(user.user_metadata?.avatar_url) ??
      getString(user.user_metadata?.picture) ??
      null,
    displayName:
      getString(user.user_metadata?.full_name) ??
      getString(user.user_metadata?.name) ??
      user.email ??
      'Unknown inviter',
    email: user.email ?? null,
  }
}

function getString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}
