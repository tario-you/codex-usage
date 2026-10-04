import type { DashboardAccountRow } from '../../lib/dashboard'
import { formatTimestamp } from '../../shared/codex'
import {
  getCurrentRateLimitWindows,
  getRateLimitWindows,
  isWeeklyWindowSpent,
  WEEKLY_WINDOW_MINS,
  type RateLimitWindowKey,
} from '../../shared/rate-limit-windows'
import { RemainingPercentageEditor } from './remaining-percentage-editor'
import { formatResetCountdown } from './reset-countdown'

export function UsageWindowList({ account, showDetails, savingUsageOverride, onSaveUsageOverride, now }: {
  account: DashboardAccountRow
  showDetails: boolean
  savingUsageOverride: string | null
  onSaveUsageOverride: (account: DashboardAccountRow, window: RateLimitWindowKey, remaining: number) => Promise<boolean>
  now: number
}) {
  // Details shows what the last sync measured, so a manual correction edits
  // that. The plain view shows what is usable now: a passed reset is full
  // again, and while the weekly window is spent its shorter windows are moot.
  const current = showDetails ? getRateLimitWindows(account) : getCurrentRateLimitWindows(account, now)
  const weeklyExhausted = isWeeklyWindowSpent(current)
  const windows = showDetails || !weeklyExhausted ? current
    : current.filter((window) => window.windowDurationMins == null || window.windowDurationMins >= WEEKLY_WINDOW_MINS)
  const isFreePlan = account.plan_type?.trim().toLowerCase() === 'free'
  return windows.length === 0 ? <span className="text-muted-foreground">N/A</span> : (
    <div className="flex flex-col gap-1">
      {windows.map((window) => (
        <div className="flex items-center gap-2" key={window.key}>
          <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${
            isFreePlan ? 'bg-muted-foreground'
              : window.windowDurationMins === 300 && weeklyExhausted ? 'bg-red-500'
              : window.remainingPercent == null ? 'bg-muted-foreground/40'
                : window.remainingPercent <= 0 ? 'bg-red-500'
                  : window.remainingPercent <= 20 ? 'bg-amber-500' : 'bg-emerald-500'
          }`} />
          <span className="w-12 text-xs text-muted-foreground">{window.label}</span>
          <RemainingPercentageEditor
            canEdit={showDetails && account.access_scope === 'owned'}
            isOverridden={window.key === 'primary' ? account.primary_remaining_overridden : account.secondary_remaining_overridden}
            isSaving={savingUsageOverride === `${account.id}:${window.key}`}
            onSave={(value) => onSaveUsageOverride(account, window.key, value)}
            value={window.remainingPercent}
            windowLabel={window.label}
          />
          {window.resetsAt || showDetails ? <span className="text-xs text-muted-foreground" title={formatTimestamp(window.resetsAt)}>
            resets {formatResetCountdown(window.resetsAt)}
          </span> : null}
        </div>
      ))}
    </div>
  )
}
