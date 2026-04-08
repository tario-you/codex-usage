import { z } from 'zod'

import {
  hasGoogleIdentity,
  InvalidSessionError,
  requireUser,
} from '../_lib/auth.js'
import { errorResponse, jsonResponse } from '../_lib/http.js'
import { hashToken } from '../_lib/security.js'
import { serviceRoleSupabase } from '../_lib/supabase.js'

const acceptInviteBodySchema = z.object({
  inviteToken: z.string().min(1),
})

export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    if (!hasGoogleIdentity(user)) {
      return errorResponse('Sign in with Google to accept this invite.', 403)
    }

    const rawBody = await request.json().catch(() => null)
    const body = acceptInviteBodySchema.parse(rawBody)
    const tokenHash = hashToken(body.inviteToken)
    const invite = await getInviteByTokenHash(tokenHash)
    if (!invite) {
      return errorResponse('This invite link is invalid.', 404)
    }

    if (invite.owner_user_id === user.id) {
      return jsonResponse({
        alreadyAccepted: true,
        ok: true,
      })
    }

    if (Date.parse(invite.expires_at) <= Date.now()) {
      await serviceRoleSupabase
        .from('codex_dashboard_share_invites')
        .update({ status: 'expired' })
        .eq('id', invite.id)
        .eq('status', 'pending')

      return errorResponse('This invite link has expired.', 410)
    }

    if (invite.status === 'expired') {
      return errorResponse('This invite link has expired.', 410)
    }

    if (invite.status === 'revoked') {
      return errorResponse('This invite link is no longer available.', 409)
    }

    if (invite.status === 'accepted' && invite.accepted_by_user_id === user.id) {
      await upsertShare({
        inviteId: invite.id,
        ownerUserId: invite.owner_user_id,
        viewerUserId: user.id,
      })

      return jsonResponse({
        alreadyAccepted: true,
        ok: true,
      })
    }

    if (invite.status !== 'pending') {
      return errorResponse('This invite link is no longer available.', 409)
    }

    const existingShare = await getExistingShare({
      ownerUserId: invite.owner_user_id,
      viewerUserId: user.id,
    })

    await upsertShare({
      inviteId: invite.id,
      ownerUserId: invite.owner_user_id,
      viewerUserId: user.id,
    })

    return jsonResponse({
      alreadyAccepted: Boolean(existingShare && !existingShare.revoked_at),
      ok: true,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues.map((issue) => issue.message).join('; '))
    }

    const message =
      error instanceof Error ? error.message : 'Unable to accept the invite.'
    const status = error instanceof InvalidSessionError ? 401 : 400
    return errorResponse(message, status)
  }
}

async function getInviteByTokenHash(tokenHash: string) {
  const { data, error } = await serviceRoleSupabase
    .from('codex_dashboard_share_invites')
    .select('*')
    .eq('invite_token_hash', tokenHash)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

async function getExistingShare({
  ownerUserId,
  viewerUserId,
}: {
  ownerUserId: string
  viewerUserId: string
}) {
  const { data, error } = await serviceRoleSupabase
    .from('codex_dashboard_shares')
    .select('id, revoked_at')
    .eq('owner_user_id', ownerUserId)
    .eq('viewer_user_id', viewerUserId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

async function upsertShare({
  inviteId,
  ownerUserId,
  viewerUserId,
}: {
  inviteId: string
  ownerUserId: string
  viewerUserId: string
}) {
  const { error } = await serviceRoleSupabase
    .from('codex_dashboard_shares')
    .upsert(
      {
        invite_id: inviteId,
        owner_user_id: ownerUserId,
        revoked_at: null,
        viewer_user_id: viewerUserId,
      },
      {
        onConflict: 'owner_user_id,viewer_user_id',
      },
    )

  if (error) {
    throw error
  }
}
