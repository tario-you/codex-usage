import { z } from 'zod'

import { InvalidSessionError, requireUser } from '../_lib/auth.js'
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
      .select('id, account_key')
      .eq('id', body.accountId)
      .eq('owner_user_id', user.id)
      .maybeSingle()

    if (accountError) {
      throw accountError
    }

    if (!account) {
      return errorResponse('Account not found.', 404)
    }

    // Remember the unlink instead of revoking the machine that reported the
    // account: one machine syncs every plan, so revoking it stopped them all.
    const { error: unlinkError } = await serviceRoleSupabase
      .from('codex_unlinked_accounts')
      .upsert(
        { account_key: account.account_key, owner_user_id: user.id },
        { onConflict: 'owner_user_id,account_key' },
      )

    if (unlinkError) {
      throw unlinkError
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
    const status = error instanceof InvalidSessionError ? 401 : 400
    return errorResponse(message, status)
  }
}
