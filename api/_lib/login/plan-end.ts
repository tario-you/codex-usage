import { z } from 'zod'

import { requireUser } from '../auth.js'
import { jsonResponse } from '../http.js'
import { SharedLoginError } from '../login-reconcile.js'
import { sharedLoginErrorResponse } from '../login-store.js'
import { serviceRoleSupabase } from '../supabase.js'

const EARLIEST = Date.parse('2020-01-01T00:00:00Z')
const LATEST = Date.parse('2100-01-01T00:00:00Z')

export const planEndInputSchema = z.object({
  accountId: z.uuid(),
  // The moment the plan stops working; null clears it.
  endsAt: z.iso
    .datetime({ offset: true })
    .refine((value) => {
      const at = Date.parse(value)
      return at >= EARLIEST && at < LATEST
    }, 'Choose a date between 2020 and 2100.')
    .nullable(),
})

/** Set or clear one owned plan's end date. Viewers read it; only the owner writes it. */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const parsed = planEndInputSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      throw new SharedLoginError(parsed.error.issues.map((issue) => issue.message).join('; '), 400)
    }

    const endsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt).toISOString() : null
    const { data, error } = await serviceRoleSupabase
      .from('codex_accounts')
      .update({ plan_ends_at: endsAt })
      .eq('id', parsed.data.accountId)
      .eq('owner_user_id', user.id)
      .select('id, plan_ends_at')
      .maybeSingle()
    if (error) {
      throw new SharedLoginError('Unable to save the plan end date.', 500)
    }
    if (!data) {
      throw new SharedLoginError('Account not found.', 404)
    }

    return jsonResponse({ accountId: data.id, planEndsAt: data.plan_ends_at })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to save the plan end date.')
  }
}
