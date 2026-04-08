import { z } from 'zod'

import { buildConnectedDashboardAuthUrl } from '../../src/shared/cli.js'
import { getPreferredDashboardOrigin } from '../../src/shared/site.js'
import { errorResponse, jsonResponse } from '../_lib/http.js'
import { hashToken } from '../_lib/security.js'
import { serviceRoleSupabase } from '../_lib/supabase.js'

const connectOpenBodySchema = z.object({
  deviceToken: z.string().min(1),
})

export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const dashboardOrigin = getPreferredDashboardOrigin(url.origin)
    const rawBody = await request.json().catch(() => null)
    const body = connectOpenBodySchema.parse(rawBody)

    const { data: device, error: deviceError } = await serviceRoleSupabase
      .from('codex_devices')
      .select('owner_user_id')
      .eq('device_token_hash', hashToken(body.deviceToken))
      .is('revoked_at', null)
      .maybeSingle()

    if (deviceError) {
      throw deviceError
    }

    if (!device) {
      return errorResponse('This device is no longer authorized.', 401)
    }

    const { data: userData, error: userError } =
      await serviceRoleSupabase.auth.admin.getUserById(device.owner_user_id)

    if (userError || !userData.user?.email) {
      throw userError ?? new Error('Unable to find a dashboard login for this device.')
    }

    const { data: linkData, error: linkError } =
      await serviceRoleSupabase.auth.admin.generateLink({
        type: 'magiclink',
        email: userData.user.email,
      })

    if (
      linkError ||
      !linkData.properties?.hashed_token ||
      !linkData.properties?.verification_type
    ) {
      throw linkError ?? new Error('Unable to create a dashboard login link.')
    }

    return jsonResponse({
      dashboardUrl: buildConnectedDashboardAuthUrl(dashboardOrigin, {
        tokenHash: linkData.properties.hashed_token,
        verificationType: linkData.properties.verification_type,
      }),
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues.map((issue) => issue.message).join('; '))
    }

    const message =
      error instanceof Error ? error.message : 'Unable to open the dashboard.'
    return errorResponse(message, 400)
  }
}
