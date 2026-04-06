import { z } from 'zod'

import type { Json } from '../../src/lib/database.types.js'
import { buildConnectedDashboardUrl } from '../../src/shared/cli.js'
import type {
  CodexAccountReadResponse,
  CodexRateLimitsResponse,
} from '../../src/shared/codex.js'
import {
  accountStateSchema,
  deviceMetadataSchema,
  rateLimitsSchema,
} from '../_lib/schemas.js'
import { errorResponse, jsonResponse } from '../_lib/http.js'
import { createOpaqueToken, hashToken } from '../_lib/security.js'
import { serviceRoleSupabase } from '../_lib/supabase.js'
import { persistSnapshotForOwner } from '../_lib/persistence.js'

const CONNECT_POLL_MS = 60_000
const GUEST_EMAIL_DOMAIN = 'codex-usage.local'

const connectStartBodySchema = z.object({
  accountState: accountStateSchema,
  device: deviceMetadataSchema.optional(),
  rateLimits: rateLimitsSchema,
})

export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const rawBody = await request.json().catch(() => null)
    const body = connectStartBodySchema.parse(rawBody)
    const accountState = body.accountState as CodexAccountReadResponse
    const rateLimits = body.rateLimits as CodexRateLimitsResponse

    if (!accountState.account) {
      return errorResponse(
        'Codex is not logged in on this machine yet. Run `codex login` first.',
        409,
      )
    }

    const machineName = body.device?.machineName ?? null
    const label = body.device?.label?.trim() || machineName || 'Local Codex'
    const guestEmail = `guest+${createOpaqueToken(12)}@${GUEST_EMAIL_DOMAIN}`
    const guestPassword = createOpaqueToken(24)
    const redirectTo = buildConnectedDashboardUrl(url.origin)

    const { data: linkData, error: linkError } =
      await serviceRoleSupabase.auth.admin.generateLink({
        type: 'signup',
        email: guestEmail,
        password: guestPassword,
        options: {
          data: {
            guest: true,
            source: 'cli-connect',
            machine_name: machineName,
          },
          redirectTo,
        },
      })

    if (linkError || !linkData.user || !linkData.properties?.action_link) {
      throw linkError ?? new Error('Unable to create a dashboard login link.')
    }

    const deviceToken = createOpaqueToken(32)
    const deviceKey = `device_${createOpaqueToken(10)}`
    const { data: device, error: deviceError } = await serviceRoleSupabase
      .from('codex_devices')
      .insert({
        codex_home: body.device?.codexHome ?? null,
        device_key: deviceKey,
        device_token_hash: hashToken(deviceToken),
        label,
        machine_name: machineName,
        metadata: {
          ...(body.device?.metadata ?? {}),
          onboarding: 'cli-connect',
        } as unknown as Json,
        owner_user_id: linkData.user.id,
      })
      .select('*')
      .single()

    if (deviceError || !device) {
      throw deviceError ?? new Error('Unable to register this device.')
    }

    await persistSnapshotForOwner({
      accountState,
      device: {
        codexHome: device.codex_home,
        deviceId: device.id,
        deviceKey: device.device_key,
        label: device.label,
        machineName: device.machine_name,
        metadata: device.metadata,
      },
      ownerUserId: linkData.user.id,
      rateLimits,
    })

    return jsonResponse({
      dashboardUrl: linkData.properties.action_link,
      deviceId: device.id,
      deviceToken,
      pollMs: CONNECT_POLL_MS,
      syncUrl: `${url.origin}/api/sync`,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues.map((issue) => issue.message).join('; '))
    }

    const message =
      error instanceof Error ? error.message : 'Unable to start dashboard connection.'
    return errorResponse(message, 400)
  }
}
