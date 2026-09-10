import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { KeyRound, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { formatRelativeTimestamp } from '@/shared/codex'
import { queryClient } from '@/lib/query-client'

import type { RepairDevice } from './repair-signins-state'

/**
 * One line under the Plans title: which machine holds expired sign-ins and a
 * button that makes that machine open the sign-ins. The person only clicks
 * through the browser tabs that appear there.
 */
export function RepairSignInsBanner({ devices, session }: { devices: RepairDevice[] | undefined; session: Session }) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const relevant = (devices ?? []).filter((device) => device.expired.length > 0 || device.pending)
  if (relevant.length === 0) return null

  async function requestRepair(device: RepairDevice) {
    setBusyId(device.id)
    setError(null)
    try {
      const response = await fetch('/api/login/repair', {
        body: JSON.stringify({ deviceId: device.id }),
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const payload = (await response.json().catch(() => null)) as { error?: string } | null
      if (!response.ok) throw new Error(payload?.error ?? 'Unable to request the repair.')
      await queryClient.invalidateQueries({ queryKey: ['repair-signins', session.user.id] })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to request the repair.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mt-2 grid gap-1.5 text-xs">
      {relevant.map((device) => {
        const machine = device.label || device.machineName || 'this machine'
        return (
          <div className="flex flex-wrap items-center gap-2" key={device.id}>
            {device.pending ? (
              <>
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                <span>
                  Sign-in tabs are opening on <span className="font-medium">{machine}</span> for{' '}
                  {device.pending.emails.join(', ')}. Finish them there.
                </span>
              </>
            ) : (
              <>
                <KeyRound className="size-3.5 text-amber-500" />
                <span>
                  {device.expired.length} sign-in{device.expired.length === 1 ? '' : 's'} expired on{' '}
                  <span className="font-medium">{machine}</span>: {device.expired.join(', ')}
                </span>
                <Button
                  disabled={busyId === device.id}
                  onClick={() => void requestRepair(device)}
                  size="sm"
                  title={`${machine} opens one sign-in tab per account; you only sign in`}
                  type="button"
                  variant="outline"
                >
                  {busyId === device.id ? 'Asking…' : 'Fix sign-ins'}
                </Button>
              </>
            )}
          </div>
        )
      })}
      {(devices ?? [])
        .filter((device) => device.lastResult && !device.pending)
        .slice(0, 1)
        .map((device) => (
          <p className="text-muted-foreground" key={`result:${device.id}`}>
            Last repair {formatRelativeTimestamp(device.lastResult?.at ?? null)}:{' '}
            {device.lastResult?.results
              .map((result) => `${result.email} ${result.outcome === 'signed-in' ? 'signed in' : result.outcome}`)
              .join(', ')}
          </p>
        ))}
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  )
}
