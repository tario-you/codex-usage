// #33: "a projection of when it will run out based on my usage pace". The
// pace is the spend seen over the most recent window of chart points, counting
// decreases only, so a plan reset (a rise) never reads as negative spend. The
// projection runs from the newest point at that pace until the total reaches
// zero. Pure: no clock is read here, so tests pin the arithmetic.
export const PROJECTION_PACE_WINDOW_MS = 24 * 60 * 60 * 1000
export const PROJECTION_MIN_POINTS = 2
const HOUR_MS = 60 * 60 * 1000

export interface UsageProjectionInputPoint {
  fetchedAt: string
  totalRemainingPercent: number
}

export interface UsageProjection {
  /** The newest point the projection starts from. */
  fromAt: string
  fromRemainingPercent: number
  /** Percent spent inside the pace window, decreases only. */
  spentPercent: number
  /** The span of chart points the pace was read over. */
  paceSpanMs: number
  /** Spend pace, percent per hour; 0 when nothing was spent in the window. */
  percentPerHour: number
  /** When the total reaches zero at that pace; null when nothing was spent. */
  runsOutAt: string | null
}

/** The projection from the newest point, or null when there are too few points to read a pace. */
export function projectRunOut(
  points: readonly UsageProjectionInputPoint[],
  { paceWindowMs = PROJECTION_PACE_WINDOW_MS }: { paceWindowMs?: number } = {},
): UsageProjection | null {
  const parsed = points
    .map((point) => ({ ...point, fetchedAtMs: Date.parse(point.fetchedAt) }))
    .filter(
      (point) =>
        Number.isFinite(point.fetchedAtMs) &&
        Number.isFinite(point.totalRemainingPercent),
    )
    .sort((left, right) => left.fetchedAtMs - right.fetchedAtMs)
  if (parsed.length < PROJECTION_MIN_POINTS) return null

  const latest = parsed[parsed.length - 1]
  const windowStartMs = latest.fetchedAtMs - paceWindowMs
  let window = parsed.filter((point) => point.fetchedAtMs >= windowStartMs)
  if (window.length < PROJECTION_MIN_POINTS) window = parsed.slice(-PROJECTION_MIN_POINTS)

  let spentPercent = 0
  for (let index = 1; index < window.length; index += 1) {
    const drop = window[index - 1].totalRemainingPercent - window[index].totalRemainingPercent
    if (drop > 0) spentPercent += drop
  }
  const paceSpanMs = latest.fetchedAtMs - window[0].fetchedAtMs
  const percentPerHour =
    paceSpanMs > 0 && spentPercent > 0 ? (spentPercent / paceSpanMs) * HOUR_MS : 0
  const remaining = Math.max(0, latest.totalRemainingPercent)
  const runsOutAtMs =
    percentPerHour > 0 && remaining > 0
      ? latest.fetchedAtMs + (remaining / percentPerHour) * HOUR_MS
      : percentPerHour > 0
        ? latest.fetchedAtMs
        : null

  return {
    fromAt: latest.fetchedAt,
    fromRemainingPercent: latest.totalRemainingPercent,
    spentPercent: Math.round(spentPercent * 100) / 100,
    paceSpanMs,
    percentPerHour: Math.round(percentPerHour * 100) / 100,
    runsOutAt: runsOutAtMs == null ? null : new Date(runsOutAtMs).toISOString(),
  }
}

/** The projected remaining at a moment on or after the projection's start, never below zero. */
export function projectedRemainingAt(projection: UsageProjection, atMs: number) {
  const fromMs = Date.parse(projection.fromAt)
  const elapsedHours = Math.max(0, atMs - fromMs) / HOUR_MS
  return Math.max(
    0,
    projection.fromRemainingPercent - projection.percentPerHour * elapsedHours,
  )
}

export interface NextWeeklyResetSource {
  label: string | null
  primary_remaining_percent: number | null
  primary_resets_at: string | null
  primary_used_percent: number | null
  primary_window_mins: number | null
  secondary_remaining_percent: number | null
  secondary_resets_at: string | null
  secondary_used_percent: number | null
  secondary_window_mins: number | null
}

export interface NextWeeklyReset {
  at: string
  label: string
}

const WEEKLY_WINDOW_MINS = 10080

/** The earliest future weekly reset among the tracked plans, with the plan's label; null when none is known. */
export function nextWeeklyReset(
  rows: readonly NextWeeklyResetSource[],
  nowMs: number,
): NextWeeklyReset | null {
  let best: NextWeeklyReset | null = null
  for (const row of rows) {
    const windows = [
      { mins: row.primary_window_mins, resetsAt: row.primary_resets_at },
      { mins: row.secondary_window_mins, resetsAt: row.secondary_resets_at },
    ]
    for (const window of windows) {
      if (window.mins !== WEEKLY_WINDOW_MINS || !window.resetsAt) continue
      const atMs = Date.parse(window.resetsAt)
      if (!Number.isFinite(atMs) || atMs <= nowMs) continue
      if (!best || atMs < Date.parse(best.at)) best = { at: window.resetsAt, label: row.label ?? 'a plan' }
    }
  }
  return best
}
