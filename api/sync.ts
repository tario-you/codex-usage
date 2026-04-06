import { z } from 'zod'

import type { Json } from '../src/lib/database.types'
import { accountStateSchema, deviceMetadataSchema, rateLimitsSchema } from './_lib/schemas'
import { errorResponse, jsonResponse } from './_lib/http'
import { hashToken } from './_lib/security'
import { serviceRoleSupabase } from './_lib/supabase'
import { persistSnapshotForOwner } from './_lib/persistence'

const syncBodySchema = z.object({
  accountState: accountStateSchema,
  device: deviceMetadataSchema.optional(),
  deviceToken: z.string().min(1),
  rateLimits: rateLimitsSchema,
})

export async function POST(request: Request) {
  try {
    const rawBody = await request.json().catch(() => null)
    const body = syncBodySchema.parse(rawBody)

    if (!body.accountState.account) {
      return errorResponse(
        'Codex is not logged in on this machine yet. Run `codex login` first.',
        409,
      )
    }

    const { data: device, error: deviceError } = await serviceRoleSupabase
      .from('codex_devices')
      .select('*')
      .eq('device_token_hash', hashToken(body.deviceToken))
      .is('revoked_at', null)
      .maybeSingle()

    if (deviceError) {
      throw deviceError
    }

    if (!device) {
      return errorResponse('This device is no longer authorized.', 401)
    }

    const nowIso = new Date().toISOString()
    const nextMetadata = {
      ...(device.metadata && typeof device.metadata === 'object'
        ? device.metadata
        : {}),
      ...(body.device?.metadata ?? {}),
    } as unknown as Json

    await serviceRoleSupabase
      .from('codex_devices')
      .update({
        codex_home: body.device?.codexHome ?? device.codex_home,
        last_seen_at: nowIso,
        machine_name: body.device?.machineName ?? device.machine_name,
        metadata: nextMetadata,
      })
      .eq('id', device.id)

    await persistSnapshotForOwner({
      accountState: body.accountState,
      device: {
        codexHome: body.device?.codexHome ?? device.codex_home,
        deviceId: device.id,
        deviceKey: device.device_key,
        label: body.device?.label?.trim() || device.label,
        machineName: body.device?.machineName ?? device.machine_name,
        metadata: nextMetadata,
      },
      ownerUserId: device.owner_user_id,
      rateLimits: body.rateLimits,
    })

    return jsonResponse({
      ok: true,
      syncedAt: nowIso,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues.map((issue) => issue.message).join('; '))
    }

    const message = error instanceof Error ? error.message : 'Unable to sync.'
    return errorResponse(message, 400)
  }
}
