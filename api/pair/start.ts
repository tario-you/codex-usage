import { requireUser } from '../_lib/auth'
import { errorResponse, jsonResponse } from '../_lib/http'
import { createOpaqueToken, hashToken } from '../_lib/security'
import { serviceRoleSupabase } from '../_lib/supabase'

const PAIRING_TTL_MS = 15 * 60 * 1000

export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const pairToken = createOpaqueToken()
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString()
    const origin = new URL(request.url).origin
    const cliUrl = `${origin}/api/cli`
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
      command: `curl -fsSL "${cliUrl}" | node - pair "${pairUrl}"`,
      expiresAt,
      pairUrl,
      syncCommand: `curl -fsSL "${cliUrl}" | node - sync --watch`,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to start pairing.'
    const status = message.includes('Authorization') ? 401 : 400
    return errorResponse(message, status)
  }
}
