import { z } from 'zod'

import type { Json } from '../../../src/lib/database.types.js'
import { requireUser } from '../auth.js'
import { errorResponse, jsonResponse } from '../http.js'
import { SharedLoginError } from '../login-reconcile.js'
import { findActiveDeviceByToken, sharedLoginErrorResponse } from '../login-store.js'
import { serviceRoleSupabase } from '../supabase.js'
import {
  readRepairState,
  withExpiredReport,
  withPendingRequest,
  withResult,
  type RepairResult,
} from './repair-state.js'

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
    ...readRepairState(row.metadata),
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
  if (error) throw new SharedLoginError('Unable to save the repair state.', 500)
}

/** The owner's machines with their expired sign-ins and any pending fix. */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request)
    const devices = await ownerDevices(user.id)
    return jsonResponse({ devices: devices.map(serializeDevice) })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to load sign-in repairs.')
  }
}

const requestSchema = z.object({
  deviceId: z.string().uuid().optional(),
  emails: z.array(z.string()).max(64).optional(),
})

/** Ask one machine (or every machine) to open sign-ins for its expired logins. */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const parsed = requestSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) return errorResponse('Pick a machine and, optionally, the emails to fix.')
    const now = new Date().toISOString()
    const devices = await ownerDevices(user.id)
    let requested = 0
    for (const device of devices) {
      if (parsed.data.deviceId && device.id !== parsed.data.deviceId) continue
      const { metadata, targets } = withPendingRequest(device.metadata, parsed.data.emails, now)
      if (targets.length === 0) continue
      await saveMetadata(device.id, metadata)
      device.metadata = metadata as unknown as Json
      requested += targets.length
    }
    if (requested === 0) {
      return errorResponse('No sign-in is waiting on that machine right now.', 409)
    }
    return jsonResponse({ devices: devices.map(serializeDevice), requested })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to request the sign-in repair.')
  }
}

const pollSchema = z.object({
  deviceToken: z.string().min(1),
  expired: z.array(z.string()).max(64).default([]),
  missing: z.array(z.string()).max(64).default([]),
})

/** The agent reports its expired and never-saved logins and learns whether the owner asked for a fix. */
export async function POLL(request: Request) {
  try {
    const parsed = pollSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return errorResponse('Send the device token and the expired emails.')
    const device = await findActiveDeviceByToken(parsed.data.deviceToken)
    if (!device) throw new SharedLoginError('Unknown or revoked device token.', 401)
    const metadata = withExpiredReport(
      device.metadata,
      parsed.data.expired,
      new Date().toISOString(),
      parsed.data.missing,
    )
    await saveMetadata(device.id, metadata)
    return jsonResponse({ pending: readRepairState(metadata).pending })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to report sign-in state.')
  }
}

const knownSchema = z.object({ deviceToken: z.string().min(1) })

/**
 * Every account the dashboard has seen for this device's owner, on any
 * machine. `login setup` merges it with the machine's own traces, so a
 * reinstalled Mac still learns which accounts to sign in as.
 */
export async function KNOWN(request: Request) {
  try {
    const parsed = knownSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return errorResponse('Send the device token.')
    const device = await findActiveDeviceByToken(parsed.data.deviceToken)
    if (!device) throw new SharedLoginError('Unknown or revoked device token.', 401)
    const { data, error } = await serviceRoleSupabase
      .from('codex_accounts')
      .select('email, plan_type, source_key, source_label, last_seen_at')
      .eq('owner_user_id', device.owner_user_id)
      .not('email', 'is', null)
      .like('account_key', 'chatgpt:%')
      .order('last_seen_at', { ascending: false })
    if (error) throw new SharedLoginError('Unable to load the known accounts.', 500)
    const seen = new Set<string>()
    const accounts: { email: string; lastSeenAt: string; planType: string | null; sourceLabel: string | null; thisDevice: boolean }[] = []
    for (const row of data ?? []) {
      const email = row.email?.trim().toLowerCase()
      if (!email || seen.has(email)) continue
      seen.add(email)
      accounts.push({
        email,
        lastSeenAt: row.last_seen_at,
        planType: row.plan_type,
        sourceLabel: row.source_label,
        thisDevice: row.source_key === device.device_key,
      })
    }
    return jsonResponse({ accounts })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to load the known accounts.')
  }
}

const doneSchema = z.object({
  deviceToken: z.string().min(1),
  results: z
    .array(
      z.object({
        detail: z.string().max(300).nullish(),
        email: z.string().min(3).max(320),
        outcome: z.enum(['signed-in', 'mismatch', 'failed', 'skipped']),
      }),
    )
    .max(64),
})

/** The agent reports what happened to each requested sign-in. */
export async function DONE(request: Request) {
  try {
    const parsed = doneSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return errorResponse('Send the device token and one result per email.')
    const device = await findActiveDeviceByToken(parsed.data.deviceToken)
    if (!device) throw new SharedLoginError('Unknown or revoked device token.', 401)
    const results: RepairResult[] = parsed.data.results.map((entry) => ({
      detail: entry.detail ?? null,
      email: entry.email.toLowerCase(),
      outcome: entry.outcome,
    }))
    const metadata = withResult(device.metadata, results, new Date().toISOString())
    await saveMetadata(device.id, metadata)
    return jsonResponse({ ok: true, state: readRepairState(metadata) })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to record the sign-in repair.')
  }
}
