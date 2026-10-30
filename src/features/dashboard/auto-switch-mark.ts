import type { Json } from '@/lib/database.types'
import { formatRelativeTimestamp } from '@/shared/codex'

/**
 * her-team#4148: a verified check on each plan the reporting machine's
 * auto-switcher can switch to. The sync agent reads the switcher's own pool
 * (claude-auto-switch's or the Codex Switchboard's saved logins) and the
 * server keeps the answer on the row as `metadata.auto_switch`; the dashboard
 * never guesses it.
 */
export interface AutoSwitchMark {
  checkedAt: string | null
  /** A Claude plan nothing on that machine can spend now: held only as an app sign-in copy (claude-logins.js). */
  idle: boolean
  inPool: boolean
  machine: string | null
}

export function readAutoSwitchMark(metadata: Json | null | undefined): AutoSwitchMark | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const mark = metadata.auto_switch
  if (!mark || typeof mark !== 'object' || Array.isArray(mark) || typeof mark.in_pool !== 'boolean') return null
  return {
    checkedAt: typeof mark.checked_at === 'string' ? mark.checked_at : null,
    idle: mark.idle === true,
    inPool: mark.in_pool,
    machine: typeof mark.machine === 'string' && mark.machine ? mark.machine : null,
  }
}

export function autoSwitchExplanation(provider: 'claude' | 'codex', mark: AutoSwitchMark) {
  const where = mark.machine ? `on ${mark.machine}` : 'on your Mac'
  const what =
    provider === 'claude' && mark.idle
      ? `claude-auto-switch ${where} keeps the Claude app's sign-in for this plan, and the app is on another plan, so nothing there has spent this one since its last reading.`
      : provider === 'claude'
      ? `claude-auto-switch ${where} has a saved sign-in for this plan. When the Claude plan you're on runs out, it can move the Claude app and Claude Code onto this one.`
      : `The Codex auto-switch ${where} has a saved sign-in for this plan. When the Codex plan you're on runs out, it can move Codex onto this one.`
  const checked = mark.checkedAt ? ` Checked ${formatRelativeTimestamp(mark.checkedAt).toLowerCase()}.` : ''
  return `In the auto-switch pool. ${what}${checked}`
}
