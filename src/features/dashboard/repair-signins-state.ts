import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import type { Session } from '@supabase/supabase-js'

export interface RepairDevice {
  providers?: ('codex' | 'claude')[]
  expired: string[]
  id: string
  label: string
  link: { provider?: 'claude'; at: string; email: string; url: string } | null
  lastResult: { at: string; results: { provider?: 'claude'; email: string; outcome: string; detail?: string | null }[] } | null
  lastSeenAt: string
  machineName: string | null
  missing: string[]
  pending: { provider?: 'claude'; emails: string[]; requestedAt: string } | null
  reportedAt: string | null
}

async function fetchRepairState(accessToken: string): Promise<RepairDevice[]> {
  const response = await fetch('/api/login/repair', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const payload = (await response.json().catch(() => null)) as
    | { devices?: RepairDevice[]; error?: string }
    | null
  if (!response.ok) throw new Error(payload?.error ?? 'Unable to load sign-in state.')
  return payload?.devices ?? []
}

/** Expired sign-ins per machine, refreshed often enough to follow a repair as it runs. */
export function useRepairState(session: Session | null) {
  return useQuery({
    enabled: Boolean(session?.access_token),
    queryFn: () => fetchRepairState(session?.access_token as string),
    queryKey: ['repair-signins', session?.user.id ?? null],
    refetchInterval: query => query.state.data?.some(device => device.pending) ? 2_000 : 15_000,
  })
}

export function expiredEmailSet(devices: RepairDevice[] | undefined) {
  const set = new Set<string>()
  for (const device of devices ?? []) for (const email of device.expired) set.add(email.toLowerCase())
  return set
}

/** Prefer an existing request, otherwise the most recently online holder of this login. */
export function repairTarget(devices: RepairDevice[] | undefined, email: string, stale = false, provider: 'codex' | 'claude' = 'codex') {
  const key = email.trim().toLowerCase()
  if (!key) return null
  const eligible = (devices ?? []).filter(device => stale || (provider === 'codex' && device.expired.some(value => value.toLowerCase() === key)))
  return eligible.find(device => (device.pending?.provider ?? 'codex') === provider && device.pending?.emails.includes(key))
    ?? eligible.sort((a, b) => Number((b.providers ?? ['codex']).includes(provider)) - Number((a.providers ?? ['codex']).includes(provider))
      || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0]
    ?? null
}

export async function postRepair(session: Session, body: Record<string, unknown>) {
  const response = await fetch('/api/login/repair', {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const payload = (await response.json().catch(() => null)) as { devices?: RepairDevice[]; error?: string } | null
  if (!response.ok) throw new Error(payload?.error ?? 'Unable to request the sign-in.')
  if (payload?.devices) queryClient.setQueryData(['repair-signins', session.user.id], payload.devices)
  await queryClient.invalidateQueries({ queryKey: ['repair-signins', session.user.id] })
}

export function isSignInStale(lastUpdate: string | null | undefined, now = Date.now()) {
  const at = Date.parse(lastUpdate ?? '')
  return Number.isFinite(at) && now - at > 12 * 60 * 60 * 1000
}
