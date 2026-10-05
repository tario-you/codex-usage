import { formatWindowLabel, getRemainingPercent } from './codex.js'

export type RateLimitWindowKey = 'primary' | 'secondary'

export interface RateLimitWindowSource {
  primary_remaining_percent: number | null
  primary_resets_at: string | null
  primary_used_percent: number | null
  primary_window_mins: number | null
  secondary_remaining_percent: number | null
  secondary_resets_at: string | null
  secondary_used_percent: number | null
  secondary_window_mins: number | null
}

export interface RateLimitWindow {
  key: RateLimitWindowKey
  label: string
  remainingPercent: number | null
  resetsAt: string | null
  windowDurationMins: number | null
}

export function getRateLimitWindows(source: RateLimitWindowSource) {
  return [
    buildRateLimitWindow(
      'primary',
      source.primary_used_percent,
      source.primary_remaining_percent,
      source.primary_window_mins,
      source.primary_resets_at,
    ),
    buildRateLimitWindow(
      'secondary',
      source.secondary_used_percent,
      source.secondary_remaining_percent,
      source.secondary_window_mins,
      source.secondary_resets_at,
    ),
  ].filter((window): window is RateLimitWindow => window !== null)
}

export const WEEKLY_WINDOW_MINS = 10_080

/**
 * The windows as they stand at `now`, not as the last sync saw them: a window
 * whose reset time has passed is full again, and its next reset is unknown
 * until the next sync.
 */
export function getCurrentRateLimitWindows(
  source: RateLimitWindowSource,
  now = Date.now(),
) {
  return getRateLimitWindows(source).map((window) => {
    const resetAt = window.resetsAt == null ? Number.NaN : Date.parse(window.resetsAt)
    return Number.isFinite(resetAt) && resetAt <= now
      ? { ...window, remainingPercent: 100, resetsAt: null }
      : window
  })
}

/**
 * The order the dashboard shows an account's windows in: the longest first, so
 * the weekly limit sits above the 5-hour one. Display only; anything that reads
 * the windows to decide keeps getRateLimitWindows' order.
 */
export function longestWindowFirst<T extends Pick<RateLimitWindow, 'windowDurationMins'>>(windows: T[]) {
  return [...windows].sort(
    (a, b) => (b.windowDurationMins ?? -1) - (a.windowDurationMins ?? -1),
  )
}

/** A spent weekly window leaves the account unusable, whatever its shorter windows say. */
export function isWeeklyWindowSpent(
  windows: Array<Pick<RateLimitWindow, 'remainingPercent' | 'windowDurationMins'>>,
) {
  return windows.some(
    (window) =>
      window.windowDurationMins === WEEKLY_WINDOW_MINS &&
      window.remainingPercent != null &&
      window.remainingPercent <= 0,
  )
}

function buildRateLimitWindow(
  key: RateLimitWindowKey,
  usedPercent: number | null,
  remainingPercent: number | null,
  windowDurationMins: number | null,
  resetsAt: string | null,
): RateLimitWindow | null {
  const isPresent =
    usedPercent != null || windowDurationMins != null || resetsAt != null
  if (!isPresent) {
    return null
  }

  return {
    key,
    label: formatWindowLabel(windowDurationMins),
    remainingPercent:
      usedPercent == null
        ? normalizeRemainingPercent(remainingPercent)
        : getRemainingPercent(usedPercent),
    resetsAt,
    windowDurationMins,
  }
}

function normalizeRemainingPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return null
  }

  return Math.max(0, Math.min(100, value))
}
