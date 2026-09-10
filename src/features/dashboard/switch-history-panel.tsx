import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { ChevronDown, ChevronRight, History } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatRelativeTimestamp, formatTimestamp } from '@/shared/codex'
import {
  describeSwitchEvent,
  groupSwitchEvents,
  type SwitchEventGroup,
  type SwitchEventView,
} from '@/shared/switch-history'

const COLLAPSED_ROWS = 6

async function fetchSwitchEvents(accessToken: string): Promise<SwitchEventView[]> {
  const response = await fetch('/api/login/switches', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; events?: SwitchEventView[] }
    | null
  if (!response.ok) {
    throw new Error(payload?.error ?? 'Unable to load the switch history.')
  }
  return payload?.events ?? []
}

function shortEmail(email: string | null) {
  if (!email) return null
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

function summary(group: SwitchEventGroup) {
  if (group.kind === 'switched') {
    const from = shortEmail(group.fromEmail)
    const to = shortEmail(group.toEmail) ?? 'another plan'
    return from ? `${from} → ${to}` : `→ ${to}`
  }
  return describeSwitchEvent(group)
}

/** Every automatic switch, continuation and relaunch, on your machines and your recipients'. */
export function SwitchHistoryPanel({ session }: { session: Session }) {
  const query = useQuery({
    queryFn: () => fetchSwitchEvents(session.access_token),
    queryKey: ['switch-history', session.user.id],
    refetchInterval: 60_000,
  })
  const [expanded, setExpanded] = useState(false)
  const groups = groupSwitchEvents(query.data ?? [])
  const visible = expanded ? groups : groups.slice(0, COLLAPSED_ROWS)

  return (
    <Card className="min-w-0" size="sm">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-1.5">
            <History className="size-3.5 text-muted-foreground" /> Switch history
          </CardTitle>
          <CardDescription>
            Automatic plan switches and resumed chats, on your machines and on the machines you
            share with.
          </CardDescription>
        </div>
        {groups.length > COLLAPSED_ROWS ? (
          <Button onClick={() => setExpanded((value) => !value)} size="sm" variant="ghost">
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {expanded ? 'Show fewer' : `Show all ${groups.length}`}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {query.error ? (
          <p className="text-destructive text-sm">{query.error.message}</p>
        ) : groups.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {query.isLoading ? 'Loading…' : 'No switches yet. The first one shows up here within a minute of happening.'}
          </p>
        ) : (
          <ul className="grid gap-0.5 text-sm">
            {visible.map((group) => (
              <li
                className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 rounded-md px-2 py-1 hover:bg-muted/50 sm:grid-cols-[5.5rem_8rem_minmax(0,1fr)]"
                key={group.id}
              >
                <span
                  className="text-muted-foreground text-xs tabular-nums"
                  title={formatTimestamp(group.occurredAt)}
                >
                  {formatRelativeTimestamp(group.occurredAt)}
                </span>
                <span className="truncate text-muted-foreground text-xs" title={group.label}>
                  {group.source === 'device' ? group.label : `${group.label} (shared)`}
                </span>
                <span className="col-span-2 min-w-0 truncate sm:col-span-1" title={group.reason ?? undefined}>
                  <span
                    className={
                      group.kind === 'switched'
                        ? 'font-medium text-foreground'
                        : 'text-muted-foreground'
                    }
                  >
                    {summary(group)}
                  </span>
                  {group.resumedCount > 0 ? (
                    <span className="text-muted-foreground">
                      {' '}
                      · {group.resumedCount} {group.resumedCount === 1 ? 'chat' : 'chats'} resumed
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
