import { z } from 'zod'

import { requireUser } from '../auth.js'
import { errorResponse, jsonResponse } from '../http.js'
import { serializeGrant, sharedLoginErrorResponse } from '../login-store.js'
import { serviceRoleSupabase } from '../supabase.js'

const revokeGrantBodySchema = z.object({
  grantId: z.uuid(),
})

/** Owner revokes one recipient. Their next sync gets 401 and stops. */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const body = revokeGrantBodySchema.parse(await request.json().catch(() => null))

    const { data: grant, error } = await serviceRoleSupabase
      .from('codex_login_grants')
      .update({ revoked_at: new Date().toISOString(), status: 'revoked' })
      .eq('id', body.grantId)
      .eq('owner_user_id', user.id)
      .select('*')
      .maybeSingle()

    if (error) {
      throw error
    }

    if (!grant) {
      return errorResponse('Login command not found.', 404)
    }

    return jsonResponse({ grant: serializeGrant(grant), ok: true })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to revoke this login.')
  }
}
