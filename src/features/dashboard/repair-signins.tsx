import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { KeyRound, Loader2, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatRelativeTimestamp } from '@/shared/codex'
import { queryClient } from '@/lib/query-client'

import type { RepairDevice } from './repair-signins-state'

async function postRepair(session: Session, body: Record<string, unknown>) {
  const response = await fetch('/api/login/repair', {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const payload = (await response.json().catch(() => null)) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error ?? 'Unable to request the sign-in.')
  await queryClient.invalidateQueries({ queryKey: ['repair-signins', session.user.id] })
}

/**
 * Connect a plan the dashboard has never seen: type its email, and the
 * machine that syncs your accounts opens the OpenAI sign-in for it. Finish
 * the sign-in there; the new login lands in the switcher store and shows up
 * in Plans on the next sync.
 */
export function ConnectPlanForm({ devices, session }: { devices: RepairDevice[] | undefined; session: Session }) {
  const [email, setEmail] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const machines = devices ?? []
  if (machines.length === 0) return null
  const chosen = machines.find((device) => device.id === deviceId) ?? machines[0]
  const machine = chosen.label || chosen.machineName || 'your machine'
  const ready = email.includes('@') && !busy

  async function connect(event: React.FormEvent) {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await postRepair(session, { connect: email.trim(), deviceId: chosen.id })
      setEmail('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to request the sign-in.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="mt-2 flex flex-wrap items-center gap-2 text-xs" onSubmit={(event) => void connect(event)}>
      <Input
        aria-label="Email of the plan to connect"
        autoComplete="email"
        className="h-8 w-56 text-xs"
        disabled={busy}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="new-plan@example.com"
        type="email"
        value={email}
      />
      {machines.length > 1 ? (
        <select
          aria-label="Machine that opens the sign-in"
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          disabled={busy}
          onChange={(event) => setDeviceId(event.target.value)}
          value={chosen.id}
        >
          {machines.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label || device.machineName || device.id}
            </option>
          ))}
        </select>
      ) : null}
      <Button disabled={!ready} size="sm" title={`${machine} opens the OpenAI sign-in for this email; you only sign in`} type="submit" variant="outline">
        <Plus className="size-3.5" />
        {busy ? 'Asking…' : 'Connect a plan'}
      </Button>
      <span className="text-muted-foreground">Opens the sign-in on {machine}.</span>
      {error ? <span className="text-destructive">{error}</span> : null}
    </form>
  )
}

/**
 * One line under the Plans title: which machine holds expired sign-ins, or
 * accounts it has used and never signed in, and a button that makes that
 * machine open the sign-ins. The person only clicks through the browser tabs
 * that appear there.
 */
export function RepairSignInsBanner({ devices, session }: { devices: RepairDevice[] | undefined; session: Session }) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const relevant = (devices ?? []).filter(
    (device) => device.expired.length > 0 || (device.missing ?? []).length > 0 || device.pending,
  )
  if (relevant.length === 0) return null

  async function requestRepair(device: RepairDevice) {
    setBusyId(device.id)
    setError(null)
    try {
      await postRepair(session, { deviceId: device.id })
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
        const missing = device.missing ?? []
        const parts: string[] = []
        if (device.expired.length > 0) {
          parts.push(`${device.expired.length} sign-in${device.expired.length === 1 ? '' : 's'} expired: ${device.expired.join(', ')}`)
        }
        if (missing.length > 0) {
          parts.push(`${missing.length} account${missing.length === 1 ? '' : 's'} used there but never signed in: ${missing.join(', ')}`)
        }
        const total = device.expired.length + missing.length
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
                  On <span className="font-medium">{machine}</span>: {parts.join('; ')}
                </span>
                <Button
                  disabled={busyId === device.id}
                  onClick={() => void requestRepair(device)}
                  size="sm"
                  title={`${machine} opens one sign-in tab per account, ${total} in all; you only sign in`}
                  type="button"
                  variant="outline"
                >
                  {busyId === device.id ? 'Asking…' : missing.length > 0 && device.expired.length === 0 ? 'Sign them in' : 'Fix sign-ins'}
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
