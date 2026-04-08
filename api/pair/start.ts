import { requireUser } from '../_lib/auth.js'
import { buildPairCommand, buildSyncCommand } from '../../src/shared/cli.js'
import { getPreferredDashboardOrigin } from '../../src/shared/site.js'
import { errorResponse, jsonResponse } from '../_lib/http.js'
import { createOpaqueToken, hashToken } from '../_lib/security.js'
import { serviceRoleSupabase } from '../_lib/supabase.js'

const PAIRING_TTL_MS = 15 * 60 * 1000

export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const pairToken = createOpaqueToken()
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString()
    const origin = getPreferredDashboardOrigin(new URL(request.url).origin)
    const pairUrl = `${origin}/api/pair/complete?token=${encodeURIComponent(pairToken)}`

    const { error } = await serviceRoleSupabase
      .from('codex_pairing_sessions')
      .insert({
        expires_at: expiresAt,
        owner_user_id: user.id,
        pair_token_hash: hashToken(pairToken),
        pair_token_preview: pairToken.slice(0, 8),
      })

    if (error) {
      throw error
    }

    return jsonResponse({
      command: buildPairCommand(pairUrl),
      expiresAt,
      pairUrl,
      syncCommand: buildSyncCommand(),
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to start pairing.'
    const status = message.includes('Authorization') ? 401 : 400
    return errorResponse(message, status)
  }
}
