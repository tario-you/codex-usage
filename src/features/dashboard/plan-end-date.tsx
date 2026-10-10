import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Check, Pencil, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { queryClient } from '@/lib/query-client'

import { formatPlanEnd, planEndFromDateInput, planEndsAt, planEndToDateInput } from './plan-end'

const EXPLANATION =
  'The plan stops working on this day. Room it still has is lost then, so it is used before room on plans that last longer.'

/**
 * A plan's end date beside its name: shown to everyone who sees the row, set
 * by the owner. The plan order reads it (reset-plan.ts), so it is data, not a
 * note.
 */
export function PlanEndDate({
  account,
  canEdit,
  now,
  session,
}: {
  account: { id: string; plan_ends_at?: string | null }
  canEdit: boolean
  now: number
  session: Session
}) {
  const endsAt = planEndsAt(account)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(endsAtIso: string | null) {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/login/plan-end', {
        body: JSON.stringify({ accountId: account.id, endsAt: endsAtIso }),
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const payload = (await response.json().catch(() => null)) as { error?: string } | null
      if (!response.ok) throw new Error(payload?.error ?? 'Unable to save the end date.')
      await queryClient.invalidateQueries({ queryKey: ['dashboard-accounts'] })
      setDraft(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save the end date.')
    } finally {
      setBusy(false)
    }
  }

  if (draft != null) {
    const parsed = planEndFromDateInput(draft)
    return (
      <form
        className="inline-flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (parsed) void save(parsed)
        }}
      >
        <Input
          aria-label="Plan end date"
          className="h-6 w-36 px-1.5 text-xs"
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setDraft(null)
          }}
          type="date"
          value={draft}
        />
        <Button aria-label="Save end date" disabled={!parsed || busy} size="icon-xs" title="Save end date" type="submit" variant="ghost">
          <Check className="size-3" />
        </Button>
        {endsAt != null ? (
          <Button disabled={busy} onClick={() => void save(null)} size="xs" title="Remove the end date" type="button" variant="ghost">
            Clear
          </Button>
        ) : null}
        <Button aria-label="Cancel" disabled={busy} onClick={() => setDraft(null)} size="icon-xs" title="Cancel" type="button" variant="ghost">
          <X className="size-3" />
        </Button>
        {error ? <span className="text-[10px] leading-4 text-destructive">{error}</span> : null}
      </form>
    )
  }

  if (endsAt == null && !canEdit) return null

  return (
    <span className="inline-flex items-center gap-0.5">
      {endsAt != null ? (
        <span className={`text-[10px] leading-4 ${endsAt <= now ? 'text-destructive' : 'text-muted-foreground'}`} title={EXPLANATION}>
          {formatPlanEnd(endsAt, now)}
        </span>
      ) : null}
      {canEdit ? (
        endsAt != null ? (
          <Button
            aria-label="Change when this plan ends"
            className="size-5 text-muted-foreground"
            onClick={() => setDraft(planEndToDateInput(account.plan_ends_at))}
            size="icon-xs"
            title="Change when this plan ends"
            type="button"
            variant="ghost"
          >
            <Pencil className="size-3" />
          </Button>
        ) : (
          <button
            className="text-[10px] leading-4 text-muted-foreground hover:text-foreground"
            onClick={() => setDraft('')}
            title={EXPLANATION}
            type="button"
          >
            set end date
          </button>
        )
      ) : null}
    </span>
  )
}
