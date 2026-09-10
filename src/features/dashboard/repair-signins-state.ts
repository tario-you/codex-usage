import { useQuery } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'

export interface RepairDevice {
  expired: string[]
  id: string
  label: string
  lastResult: { at: string; results: { email: string; outcome: string; detail?: string | null }[] } | null
  lastSeenAt: string
  machineName: string | null
  missing: string[]
  pending: { emails: string[]; requestedAt: string } | null
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
    refetchInterval: 15_000,
  })
}

export function expiredEmailSet(devices: RepairDevice[] | undefined) {
  const set = new Set<string>()
  for (const device of devices ?? []) for (const email of device.expired) set.add(email.toLowerCase())
  return set
}
