/** Switch history shapes shared by the API and the dashboard. Pure: no env, no I/O. */
export const SWITCH_EVENT_KINDS = ['switched', 'resumed', 'relaunched'] as const
export type SwitchEventKind = (typeof SWITCH_EVENT_KINDS)[number]

export interface SwitchEventView {
  fromEmail: string | null
  id: string
  kind: SwitchEventKind
  label: string
  occurredAt: string
  reason: string | null
  source: 'device' | 'grant'
  toEmail: string | null
}

export type SwitchEventGroup = SwitchEventView & { resumedCount: number }

/** Newest first; continuations within a minute after a switch fold into it. */
export function groupSwitchEvents(events: SwitchEventView[]): SwitchEventGroup[] {
  const oldestFirst = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
  const groups: SwitchEventGroup[] = []
  for (const event of oldestFirst) {
    if (event.kind === 'resumed') {
      const parent = [...groups].reverse().find(
        (group) =>
          group.kind !== 'resumed' &&
          group.label === event.label &&
          Date.parse(event.occurredAt) >= Date.parse(group.occurredAt) &&
          Date.parse(event.occurredAt) - Date.parse(group.occurredAt) <= 60_000,
      )
      if (parent) {
        parent.resumedCount += 1
        continue
      }
    }
    groups.push({ ...event, resumedCount: 0 })
  }
  return groups.reverse()
}

/** One stable key per event so re-uploads and retries never duplicate a row. */
export function switchEventDedupeKey(input: {
  source: 'device' | 'grant'
  sourceId: string
  kind: SwitchEventKind
  occurredAt: string
}) {
  return `${input.source}:${input.sourceId}:${input.kind}:${new Date(input.occurredAt).toISOString()}`
}

export function describeSwitchEvent(group: SwitchEventGroup) {
  if (group.kind === 'switched') {
    const to = group.toEmail ?? 'another plan'
    return group.fromEmail ? `${group.fromEmail} → ${to}` : `→ ${to}`
  }
  if (group.kind === 'relaunched') return 'Codex relaunched with the switcher'
  return 'chat resumed'
}
