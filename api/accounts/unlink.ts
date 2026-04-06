import { z } from 'zod'

import { requireUser } from '../_lib/auth.js'
import { errorResponse, jsonResponse } from '../_lib/http.js'
import { serviceRoleSupabase } from '../_lib/supabase.js'

const unlinkBodySchema = z.object({
  accountId: z.uuid(),
})

export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const rawBody = await request.json().catch(() => null)
    const body = unlinkBodySchema.parse(rawBody)

    const { data: account, error: accountError } = await serviceRoleSupabase
      .from('codex_accounts')
      .select('id, source_key')
      .eq('id', body.accountId)
      .eq('owner_user_id', user.id)
      .maybeSingle()

    if (accountError) {
      throw accountError
    }

    if (!account) {
      return errorResponse('Account not found.', 404)
    }

    const revokedAt = new Date().toISOString()
    const { error: revokeError } = await serviceRoleSupabase
      .from('codex_devices')
      .update({
        revoked_at: revokedAt,
      })
      .eq('device_key', account.source_key)
      .eq('owner_user_id', user.id)
      .is('revoked_at', null)

    if (revokeError) {
      throw revokeError
    }

    const { error: deleteError } = await serviceRoleSupabase
      .from('codex_accounts')
      .delete()
      .eq('id', account.id)
      .eq('owner_user_id', user.id)

    if (deleteError) {
      throw deleteError
    }

    return jsonResponse({ ok: true })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues.map((issue) => issue.message).join('; '))
    }

    const message =
      error instanceof Error ? error.message : 'Unable to unlink the account.'
    const status = message.includes('Authorization') ? 401 : 400
    return errorResponse(message, status)
  }
}
