import type { Database } from '../../src/lib/database.types.js'
import { SharedLoginError } from './login-reconcile.js'
import { serviceRoleSupabase } from './supabase.js'
import {
  switchEventDedupeKey,
  type SwitchEventKind,
  type SwitchEventView,
} from './switch-events.js'

type SwitchEventInsert = Database['public']['Tables']['codex_switch_events']['Insert']

interface RecordSwitchEventInput {
  ownerUserId: string
  source: 'device' | 'grant'
  deviceId?: string | null
  grantId?: string | null
  kind: SwitchEventKind
  fromEmail?: string | null
  toEmail?: string | null
  reason?: string | null
  occurredAt: string
}

function toInsert(input: RecordSwitchEventInput): SwitchEventInsert {
  const sourceId = input.source === 'device' ? input.deviceId : input.grantId
  if (!sourceId) {
    throw new SharedLoginError('A switch event needs its device or grant.', 500)
  }
  return {
    owner_user_id: input.ownerUserId,
    source: input.source,
    device_id: input.source === 'device' ? sourceId : null,
    grant_id: input.source === 'grant' ? sourceId : null,
    kind: input.kind,
    from_email: input.fromEmail ?? null,
    to_email: input.toEmail ?? null,
    reason: input.reason ?? null,
    occurred_at: new Date(input.occurredAt).toISOString(),
    dedupe_key: switchEventDedupeKey({
      source: input.source,
      sourceId,
      kind: input.kind,
      occurredAt: input.occurredAt,
    }),
  }
}

/** Idempotent: a repeated upload of the same event is a no-op. */
export async function recordSwitchEvents(inputs: RecordSwitchEventInput[]) {
  if (inputs.length === 0) return 0
  const rows = inputs.map(toInsert)
  const { error } = await serviceRoleSupabase
    .from('codex_switch_events')
    .upsert(rows, { onConflict: 'dedupe_key', ignoreDuplicates: true })
  if (error) {
    throw new SharedLoginError('Unable to record the switch history.', 500)
  }
  return rows.length
}

/** The owner's own history, newest first, labelled by device or recipient. */
export async function listSwitchEvents(ownerUserId: string, limit = 200): Promise<SwitchEventView[]> {
  const { data, error } = await serviceRoleSupabase
    .from('codex_switch_events')
    .select('id, source, device_id, grant_id, kind, from_email, to_email, reason, occurred_at')
    .eq('owner_user_id', ownerUserId)
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (error) {
    throw new SharedLoginError('Unable to load the switch history.', 500)
  }
  const rows = data ?? []
  const deviceIds = [...new Set(rows.map((row) => row.device_id).filter((id): id is string => Boolean(id)))]
  const grantIds = [...new Set(rows.map((row) => row.grant_id).filter((id): id is string => Boolean(id)))]
  const [devices, grants] = await Promise.all([
    deviceIds.length
      ? serviceRoleSupabase.from('codex_devices').select('id, label, machine_name').in('id', deviceIds)
      : Promise.resolve({ data: [], error: null }),
    grantIds.length
      ? serviceRoleSupabase.from('codex_login_grants').select('id, label, claimed_label, claimed_machine_name').in('id', grantIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  const deviceLabel = new Map(
    (devices.data ?? []).map((device) => [device.id, device.label || device.machine_name || 'Your machine']),
  )
  const grantLabel = new Map(
    (grants.data ?? []).map((grant) => [
      grant.id,
      grant.label || grant.claimed_label || grant.claimed_machine_name || 'Recipient',
    ]),
  )
  return rows.map((row) => ({
    id: row.id,
    source: row.source as 'device' | 'grant',
    kind: row.kind as SwitchEventKind,
    label:
      row.source === 'device'
        ? deviceLabel.get(row.device_id ?? '') ?? 'Your machine'
        : grantLabel.get(row.grant_id ?? '') ?? 'Recipient',
    fromEmail: row.from_email,
    toEmail: row.to_email,
    reason: row.reason,
    occurredAt: row.occurred_at,
  }))
}
