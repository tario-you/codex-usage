import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ExternalLink, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { isSignInStale, postRepair, repairTarget, type RepairDevice } from './repair-signins-state'

/** Reconnect exactly this row on the machine that reported its expired login. */
export function ReconnectSignIn({ devices, email, session, lastUpdate, provider = 'codex' }: {
  devices: RepairDevice[] | undefined
  email: string | null | undefined
  session: Session
  lastUpdate?: string | null
  provider?: 'codex' | 'claude'
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = (email ?? '').trim().toLowerCase()
  const stale = isSignInStale(lastUpdate)
  const device = repairTarget(devices, key, stale, provider)
  if (!device) return null
  const machine = device.label || device.machineName || 'your machine'
  const pending = (device.pending?.provider ?? 'codex') === provider && device.pending?.emails.includes(key)
  const link = pending && (device.link?.provider ?? 'codex') === provider && device.link?.email === key ? device.link : null
  const last = device.lastResult?.results.find(result => result.email === key && (result.provider ?? 'codex') === provider)
  const failure = !pending && last && last.outcome !== 'signed-in' ? last.detail || `Sign-in ${last.outcome}. Try again.` : null

  async function reconnect() {
    if (!device || device.pending || busy) return
    setBusy(true)
    setError(null)
    try {
      await postRepair(session, stale || provider === 'claude'
        ? { deviceId: device.id, connect: key, provider }
        : { deviceId: device.id, emails: [key] })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to start sign-in.')
    } finally {
      setBusy(false)
    }
  }

  return <span className="inline-flex flex-wrap items-center gap-1.5">
    {link ? <Button asChild className="h-5 px-1.5 text-[10px]" size="xs" variant="outline">
      <a href={link.url} rel="noreferrer" target="_blank" title={`Finish signing in as ${key} in a browser on ${machine}`}>
        <ExternalLink className="size-3" />Continue sign-in
      </a>
    </Button> : <Button
      className="h-5 border-amber-500/40 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
      disabled={busy || Boolean(device.pending)}
      onClick={() => void reconnect()}
      size="xs"
      title={device.pending ? `Waiting for sign-in on ${machine}` : `${stale ? 'Last update is over 12 hours old' : 'Sign-in expired'}. Reconnect ${key} on ${machine}`}
      type="button"
      variant="outline"
    >
      {busy || pending ? <><Loader2 className="size-3 animate-spin" />Opening sign-in…</> : stale ? 'Update stale sign-in' : 'Sign in'}
    </Button>}
    {pending && !link ? <span className="text-[10px] text-muted-foreground">Waiting for {machine}; keep it online.</span> : null}
    {error || failure ? <span role="alert" className="text-[10px] text-destructive">{error || failure}</span> : null}
  </span>
}
