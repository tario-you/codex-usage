import { z } from 'zod'

import { InvalidSessionError, requireUser } from '../_lib/auth.js'
import { errorResponse, jsonResponse } from '../_lib/http.js'
import { serviceRoleSupabase } from '../_lib/supabase.js'

const overrideBodySchema = z.object({
  accountId: z.uuid(),
  remainingPercent: z.number().int().min(0).max(100),
  windowKey: z.enum(['primary', 'secondary']),
})

export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const body = overrideBodySchema.parse(await request.json().catch(() => null))

    const { data: account, error: accountError } = await serviceRoleSupabase
      .from('codex_accounts')
      .select('id')
      .eq('id', body.accountId)
      .eq('owner_user_id', user.id)
      .maybeSingle()

    if (accountError) {
      throw accountError
    }

    if (!account) {
      return errorResponse('Account not found.', 404)
    }

    const { data: snapshot, error: snapshotError } = await serviceRoleSupabase
      .from('codex_usage_snapshots')
      .select('id, primary_used_percent, secondary_used_percent')
      .eq('account_id', account.id)
      .order('fetched_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (snapshotError) {
      throw snapshotError
    }

    if (!snapshot || snapshot[`${body.windowKey}_used_percent`] == null) {
      return errorResponse('That usage window is not available to edit.', 409)
    }

    const { error: overrideError } = await serviceRoleSupabase
      .from('codex_usage_percentage_overrides')
      .upsert(
        {
          account_id: account.id,
          remaining_percent: body.remainingPercent,
          source_snapshot_id: snapshot.id,
          window_key: body.windowKey,
        },
        { onConflict: 'account_id,window_key' },
      )

    if (overrideError) {
      throw overrideError
    }

    return jsonResponse({ ok: true })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues.map((issue) => issue.message).join('; '))
    }

    const message =
      error instanceof Error ? error.message : 'Unable to update the percentage.'
    return errorResponse(message, error instanceof InvalidSessionError ? 401 : 400)
  }
}
