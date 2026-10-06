import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

import { clearPendingReaderGrant, readerHost, type PendingReaderGrant } from './reader-grant'

/** her-team#5389: Allow Samantha for Mac to show this dashboard on her page. Read only; one tap. */
export function ReaderGrantPanel({ pending, session, onDone }: { pending: PendingReaderGrant; session: Session; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const host = readerHost(pending.returnTo)
  async function allow() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/login/reader/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify(pending),
      })
      const payload = (await response.json().catch(() => null)) as { url?: string; error?: string } | null
      if (!response.ok || !payload?.url) throw new Error(payload?.error ?? 'Unable to allow Samantha right now.')
      clearPendingReaderGrant(window.sessionStorage)
      window.location.assign(payload.url)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to allow Samantha right now.')
      setBusy(false)
    }
  }
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Show this dashboard in Samantha for Mac?</CardTitle>
        <CardDescription>
          {host ? `Samantha at ${host}` : 'Samantha'} will read your accounts, usage, history and switch history to show them on
          her page. She cannot switch plans, sign in, unlink anything or see notes and passwords.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2">
          <Button disabled={busy} onClick={() => void allow()} size="sm" type="button">{busy ? 'Allowing…' : 'Allow'}</Button>
          <Button disabled={busy} onClick={() => { clearPendingReaderGrant(window.sessionStorage); onDone() }} size="sm" type="button" variant="ghost">
            Not now
          </Button>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  )
}
