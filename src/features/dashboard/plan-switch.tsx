import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ArrowRightLeft, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { formatRelativeTimestamp } from '@/shared/codex'

import { requestPlanSwitch, type PlanSwitchDevice } from './plan-switch-state'

/**
 * The control at the end of a Plans row: "active" on the login the machine
 * is signed into, a spinner while a switch runs, otherwise a "Use" button
 * that makes that login active there. Rendered only once a machine has
 * reported which login it is on.
 */
export function UsePlanControl({
  device,
  email,
  session,
}: {
  device: PlanSwitchDevice | null
  email: string | null | undefined
  session: Session
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = (email ?? '').trim().toLowerCase()
  if (!device || !key) return null
  const machine = device.label || device.machineName || 'your machine'

  if (device.active?.email === key) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-emerald-500/40 px-1 text-[10px] leading-4 text-emerald-600 dark:text-emerald-400"
        title={`Codex on ${machine} is signed in as this plan (reported ${formatRelativeTimestamp(device.active.reportedAt)})`}
      >
        active
      </span>
    )
  }

  if (device.pending?.email === key || busy) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] leading-4 text-muted-foreground" title={`Switching Codex on ${machine} to this plan`}>
        <Loader2 className="size-3 animate-spin" />
        switching…
      </span>
    )
  }

  const failed = device.lastResult?.outcome === 'failed' && device.lastResult.email === key ? device.lastResult : null
  const message = error ?? failed?.detail ?? null

  async function use() {
    setBusy(true)
    setError(null)
    try {
      await requestPlanSwitch(session, device as PlanSwitchDevice, key)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to request the switch.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Button
        className="h-5 px-1.5 text-[10px]"
        disabled={Boolean(device.pending)}
        onClick={() => void use()}
        size="xs"
        title={device.pending ? `${machine} is switching to ${device.pending.email}` : `Make this the active plan for Codex on ${machine}`}
        type="button"
        variant="outline"
      >
        <ArrowRightLeft className="size-3" />
        Use
      </Button>
      {message ? (
        <span className="max-w-64 truncate text-[10px] leading-4 text-destructive" title={message}>
          {message}
        </span>
      ) : null}
    </span>
  )
}
