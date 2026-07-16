import { formatWindowLabel, getRemainingPercent } from './codex'

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
