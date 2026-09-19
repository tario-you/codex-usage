import { randomBytes } from 'node:crypto'

import { z } from 'zod'

import type { Json } from '../../../src/lib/database.types.js'
import { requireUser } from '../auth.js'
import { errorResponse, jsonResponse } from '../http.js'
import { SharedLoginError } from '../login-reconcile.js'
import { findActiveDeviceByToken, sharedLoginErrorResponse } from '../login-store.js'
import { serviceRoleSupabase } from '../supabase.js'
import { readPlanSwitchState, withActiveReport, withSwitchRequest, withSwitchResult } from './switch-state.js'

const DEVICE_COLUMNS = 'id, label, machine_name, last_seen_at, metadata'

interface DeviceRow {
  id: string
  label: string
  last_seen_at: string
  machine_name: string | null
  metadata: Json
}

function serializeDevice(row: DeviceRow) {
  return {
    id: row.id,
    label: row.label,
    lastSeenAt: row.last_seen_at,
    machineName: row.machine_name,
    ...readPlanSwitchState(row.metadata),
  }
}

async function ownerDevices(ownerUserId: string) {
  const { data, error } = await serviceRoleSupabase
    .from('codex_devices')
    .select(DEVICE_COLUMNS)
    .eq('owner_user_id', ownerUserId)
    .is('revoked_at', null)
    .order('last_seen_at', { ascending: false })
  if (error) throw new SharedLoginError('Unable to load your machines.', 500)
  return (data ?? []) as DeviceRow[]
}

async function saveMetadata(deviceId: string, metadata: Record<string, unknown>) {
  const { error } = await serviceRoleSupabase
    .from('codex_devices')
    .update({ metadata: metadata as unknown as Json })
    .eq('id', deviceId)
  if (error) throw new SharedLoginError('Unable to save the switch state.', 500)
}

/** The owner's machines with the login each one is on and any switch in flight. */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request)
    const devices = await ownerDevices(user.id)
    return jsonResponse({ devices: devices.map(serializeDevice) })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to load the plan switch state.')
  }
}

const requestSchema = z.object({
  deviceId: z.string().uuid().optional(),
  email: z.string().trim().email().max(320),
})

/**
 * The click. The chosen machine (else the most recently seen one that has
 * reported its active login) switches to that email on its next poll.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const parsed = requestSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) return errorResponse('Pick a plan by its email address.')
    const devices = await ownerDevices(user.id)
    const device = parsed.data.deviceId
      ? devices.find((entry) => entry.id === parsed.data.deviceId)
      : devices.find((entry) => readPlanSwitchState(entry.metadata).active) ?? devices[0]
    if (!device) return errorResponse('No machine is syncing your plans; run the sync agent first.', 409)
    const now = new Date().toISOString()
    const outcome = withSwitchRequest(device.metadata, parsed.data.email, randomBytes(12).toString('hex'), now)
    if (outcome.reason === 'invalid-email') return errorResponse('Pick a plan by its email address.')
    if (outcome.reason === 'busy') {
      return errorResponse(`That machine is already switching to ${outcome.pending?.email}; wait for it to finish.`, 409)
    }
    if (outcome.reason === 'already-active') return errorResponse('That plan is already the active one there.', 409)
    if (outcome.reason === null) {
      await saveMetadata(device.id, outcome.metadata)
      device.metadata = outcome.metadata as unknown as Json
    }
    return jsonResponse({ devices: devices.map(serializeDevice), pending: outcome.pending })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to request the plan switch.')
  }
}

const pollSchema = z.object({
  activeEmail: z.string().max(320).nullable().optional(),
  deviceToken: z.string().min(1),
})

/** The agent reports its active login and learns whether the owner asked for a switch. */
export async function POLL(request: Request) {
  try {
    const parsed = pollSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return errorResponse('Send the device token and the active email.')
    const device = await findActiveDeviceByToken(parsed.data.deviceToken)
    if (!device) throw new SharedLoginError('Unknown or revoked device token.', 401)
    const now = new Date().toISOString()
    const metadata = withActiveReport(device.metadata, parsed.data.activeEmail ?? null, now)
    await saveMetadata(device.id, metadata)
    return jsonResponse({ pending: readPlanSwitchState(metadata).pending })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to report the active plan.')
  }
}

const doneSchema = z.object({
  detail: z.string().max(300).nullish(),
  deviceToken: z.string().min(1),
  email: z.string().min(3).max(320),
  outcome: z.enum(['switched', 'failed']),
  requestId: z.string().max(64).nullish(),
})

/** The agent reports what happened to the requested switch. */
export async function DONE(request: Request) {
  try {
    const parsed = doneSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return errorResponse('Send the device token, the email, and the outcome.')
    const device = await findActiveDeviceByToken(parsed.data.deviceToken)
    if (!device) throw new SharedLoginError('Unknown or revoked device token.', 401)
    const metadata = withSwitchResult(
      device.metadata,
      {
        detail: parsed.data.detail ?? null,
        email: parsed.data.email,
        outcome: parsed.data.outcome,
        requestId: parsed.data.requestId ?? null,
      },
      new Date().toISOString(),
    )
    await saveMetadata(device.id, metadata)
    return jsonResponse({ ok: true, state: readPlanSwitchState(metadata) })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to record the plan switch.')
  }
}
