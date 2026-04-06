import { z } from 'zod'

import type { Json } from '../../src/lib/database.types'
import { deviceMetadataSchema, accountStateSchema, rateLimitsSchema } from '../_lib/schemas'
import { errorResponse, jsonResponse } from '../_lib/http'
import { createOpaqueToken, hashToken } from '../_lib/security'
import { serviceRoleSupabase } from '../_lib/supabase'
import { persistSnapshotForOwner } from '../_lib/persistence'

const PAIR_COMPLETE_POLL_MS = 60_000

const pairCompleteBodySchema = z.object({
  accountState: accountStateSchema,
  device: deviceMetadataSchema.optional(),
  pairToken: z.string().min(1).optional(),
  rateLimits: rateLimitsSchema,
})

export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const rawBody = await request.json().catch(() => null)
    const body = pairCompleteBodySchema.parse(rawBody)
    const pairToken = url.searchParams.get('token') ?? body.pairToken ?? null

    if (!pairToken) {
      return errorResponse('Missing pairing token.', 400)
    }

    if (!body.accountState.account) {
      return errorResponse(
        'Codex is not logged in on this machine yet. Run `codex login` first.',
        409,
      )
    }

    const tokenHash = hashToken(pairToken)
    const { data: pairingSession, error: pairingError } = await serviceRoleSupabase
      .from('codex_pairing_sessions')
      .select('*')
      .eq('pair_token_hash', tokenHash)
      .maybeSingle()

    if (pairingError) {
      throw pairingError
    }

    if (!pairingSession) {
      return errorResponse('This pairing link is invalid.', 404)
    }

    if (pairingSession.status !== 'pending') {
      return errorResponse('This pairing link has already been used.', 409)
    }

    if (Date.parse(pairingSession.expires_at) <= Date.now()) {
      await serviceRoleSupabase
        .from('codex_pairing_sessions')
        .update({ status: 'expired' })
        .eq('id', pairingSession.id)

      return errorResponse('This pairing link has expired.', 410)
    }

    const deviceToken = createOpaqueToken(32)
    const deviceKey = `device_${createOpaqueToken(10)}`
    const machineName = body.device?.machineName ?? null
    const label = body.device?.label?.trim() || machineName || 'Local Codex'

    const { data: device, error: deviceError } = await serviceRoleSupabase
      .from('codex_devices')
      .insert({
        codex_home: body.device?.codexHome ?? null,
        device_key: deviceKey,
        device_token_hash: hashToken(deviceToken),
        label,
        machine_name: machineName,
        metadata: (body.device?.metadata ?? {}) as unknown as Json,
        owner_user_id: pairingSession.owner_user_id,
        pairing_session_id: pairingSession.id,
      })
      .select('*')
      .single()

    if (deviceError || !device) {
      throw deviceError ?? new Error('Unable to register this device.')
    }

    await persistSnapshotForOwner({
      accountState: body.accountState,
      device: {
        codexHome: device.codex_home,
        deviceId: device.id,
        deviceKey: device.device_key,
        label: device.label,
        machineName: device.machine_name,
        metadata: device.metadata,
      },
      ownerUserId: pairingSession.owner_user_id,
      rateLimits: body.rateLimits,
    })

    const nowIso = new Date().toISOString()
    await serviceRoleSupabase
      .from('codex_pairing_sessions')
      .update({
        last_seen_at: nowIso,
        paired_at: nowIso,
        status: 'paired',
      })
      .eq('id', pairingSession.id)

    return jsonResponse({
      deviceId: device.id,
      deviceToken,
      pollMs: PAIR_COMPLETE_POLL_MS,
      syncUrl: `${url.origin}/api/sync`,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues.map((issue) => issue.message).join('; '))
    }

    const message =
      error instanceof Error ? error.message : 'Unable to finish pairing.'
    return errorResponse(message, 400)
  }
}
