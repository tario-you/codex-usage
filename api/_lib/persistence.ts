import type { Database, Json } from '../../src/lib/database.types.js'
import {
  parseCreditsBalance,
  unixSecondsToIso,
  type CodexAccountReadResponse,
  type CodexRateLimitsResponse,
} from '../../src/shared/codex.js'
import { serviceRoleSupabase } from './supabase.js'

interface DeviceContext {
  codexHome: string | null
  deviceId: string
  deviceKey: string
  label: string
  machineName: string | null
  metadata?: Json
}

interface PersistSnapshotInput {
  accountState: CodexAccountReadResponse
  device: DeviceContext
  ownerUserId: string
  rateLimits: CodexRateLimitsResponse
}

export async function persistSnapshotForOwner({
  accountState,
  device,
  ownerUserId,
  rateLimits,
}: PersistSnapshotInput) {
  const account = accountState.account
  if (!account) {
    throw new Error('No logged-in Codex account was found on this machine.')
  }

  const email =
    account.type === 'chatgpt' && account.email
      ? account.email.toLowerCase()
      : null
  const accountKey = email ? `chatgpt:${email}` : `source:${device.deviceKey}`
  const nowIso = new Date().toISOString()
  const primary = rateLimits.rateLimits.primary
  const secondary = rateLimits.rateLimits.secondary

  const accountUpsert: Database['public']['Tables']['codex_accounts']['Insert'] =
    {
      account_key: accountKey,
      codex_home: device.codexHome,
      display_name: email ? null : device.label,
      email,
      last_seen_at: nowIso,
      last_snapshot_at: nowIso,
      metadata: {
        auth_type: account.type,
        device_id: device.deviceId,
        device_label: device.label,
        device_metadata: device.metadata ?? {},
        limit_ids: Object.keys(rateLimits.rateLimitsByLimitId ?? {}),
        machine_name: device.machineName,
        transport: 'stdio',
      },
      owner_user_id: ownerUserId,
      plan_type:
        rateLimits.rateLimits.planType ??
        (account.type === 'chatgpt' ? account.planType ?? null : null),
      source_key: device.deviceKey,
      source_label: device.label,
    }

  const { data: accountRecord, error: upsertError } = await serviceRoleSupabase
    .from('codex_accounts')
    .upsert(accountUpsert, {
      onConflict: 'owner_user_id,account_key',
    })
    .select('id')
    .single()

  if (upsertError || !accountRecord) {
    throw upsertError ?? new Error('Failed to upsert the Codex account.')
  }

  const snapshotInsert: Database['public']['Tables']['codex_usage_snapshots']['Insert'] =
    {
      account_id: accountRecord.id,
      credits_balance: parseCreditsBalance(
        rateLimits.rateLimits.credits?.balance,
      ),
      fetched_at: nowIso,
      has_credits: rateLimits.rateLimits.credits?.hasCredits ?? null,
      primary_resets_at: unixSecondsToIso(primary?.resetsAt),
      primary_used_percent: primary?.usedPercent ?? null,
      primary_window_mins: primary?.windowDurationMins ?? null,
      raw_rate_limits: rateLimits.rateLimits as unknown as Json,
      raw_rate_limits_by_limit_id: (rateLimits.rateLimitsByLimitId ??
        {}) as unknown as Json,
      secondary_resets_at: unixSecondsToIso(secondary?.resetsAt),
      secondary_used_percent: secondary?.usedPercent ?? null,
      secondary_window_mins: secondary?.windowDurationMins ?? null,
      source_key: device.deviceKey,
      unlimited_credits: rateLimits.rateLimits.credits?.unlimited ?? null,
    }

  const { error: snapshotError } = await serviceRoleSupabase
    .from('codex_usage_snapshots')
    .insert(snapshotInsert)

  if (snapshotError) {
    throw snapshotError
  }
}
