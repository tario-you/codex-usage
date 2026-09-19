import { useQuery } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'

import { queryClient } from '@/lib/query-client'

export interface PlanSwitchDevice {
  active: { email: string; reportedAt: string } | null
  id: string
  label: string
  lastResult: {
    at: string
    detail: string | null
    email: string
    outcome: 'switched' | 'failed'
    requestId: string | null
  } | null
  lastSeenAt: string
  machineName: string | null
  pending: { email: string; requestId: string; requestedAt: string } | null
}

/** A machine whose active-login report is older than this is not offered a switch. */
export const PLAN_SWITCH_ACTIVE_MAX_AGE_MS = 5 * 60 * 1000

const queryKey = (userId: string | null) => ['plan-switch', userId]

async function fetchPlanSwitchState(accessToken: string): Promise<PlanSwitchDevice[]> {
  const response = await fetch('/api/login/switch', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const payload = (await response.json().catch(() => null)) as
    | { devices?: PlanSwitchDevice[]; error?: string }
    | null
  if (!response.ok) throw new Error(payload?.error ?? 'Unable to load the plan switch state.')
  return payload?.devices ?? []
}

/** Which login each machine is on, refreshed often enough to follow a switch as it runs. */
export function usePlanSwitchState(session: Session | null) {
  return useQuery({
    enabled: Boolean(session?.access_token),
    queryFn: () => fetchPlanSwitchState(session?.access_token as string),
    queryKey: queryKey(session?.user.id ?? null),
    refetchInterval: 10_000,
  })
}

/**
 * The machine a "Use" click goes to: the most recently seen one whose agent
 * has reported its active login lately. Machines that only sync a store
 * (no Codex desktop, no Switchboard) never report one and are never picked.
 */
export function planSwitchTarget(devices: PlanSwitchDevice[] | undefined, now = Date.now()) {
  return (
    (devices ?? []).find(
      (device) =>
        device.active !== null &&
        Number.isFinite(Date.parse(device.active.reportedAt)) &&
        now - Date.parse(device.active.reportedAt) <= PLAN_SWITCH_ACTIVE_MAX_AGE_MS,
    ) ?? null
  )
}

export async function requestPlanSwitch(session: Session, device: PlanSwitchDevice, email: string) {
  const response = await fetch('/api/login/switch', {
    body: JSON.stringify({ deviceId: device.id, email }),
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const payload = (await response.json().catch(() => null)) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error ?? 'Unable to request the switch.')
  await queryClient.invalidateQueries({ queryKey: queryKey(session.user.id) })
}
