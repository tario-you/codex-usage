// #35 and #36: what the chart says under the pointer, and where nothing was
// spent. Pure over chart coordinates, so tests pin both without a DOM.
import { projectedRemainingAt, type UsageProjection } from './usage-projection'

export interface ChartHoverPoint {
  fetchedAt: string
  totalRemainingPercent: number
  x: number
  y: number
}

/** The chart's axes in viewBox units and the times they span. */
export interface ChartHoverDomain {
  bottom: number
  domainEndMs: number
  left: number
  right: number
  startMs: number
  top: number
  yMax: number
}

export interface ChartHoverReading {
  kind: 'history' | 'projection'
  at: string
  remainingPercent: number
  x: number
  y: number
}

export function timeAtX(x: number, domain: ChartHoverDomain) {
  const span = domain.right - domain.left
  const ratio = span > 0 ? Math.min(Math.max((x - domain.left) / span, 0), 1) : 0
  return domain.startMs + ratio * (domain.domainEndMs - domain.startMs)
}

export function xAtTime(time: number, domain: ChartHoverDomain) {
  const spanMs = domain.domainEndMs - domain.startMs
  const ratio =
    spanMs > 0 ? Math.min(Math.max((time - domain.startMs) / spanMs, 0), 1) : 0
  return round(domain.left + ratio * (domain.right - domain.left))
}

export function yAtValue(value: number, domain: ChartHoverDomain) {
  const clamped = Math.min(Math.max(value, 0), domain.yMax)
  return round(domain.bottom - (clamped / domain.yMax) * (domain.bottom - domain.top))
}

/** The point the chart names for a pointer at x: the nearest history point, or the projection past the newest point. */
export function readingAtX(
  x: number,
  {
    coordinates,
    domain,
    projection = null,
    projectionEndMs = null,
  }: {
    coordinates: readonly ChartHoverPoint[]
    domain: ChartHoverDomain
    projection?: UsageProjection | null
    projectionEndMs?: number | null
  },
): ChartHoverReading | null {
  if (coordinates.length === 0) return null
  const latest = coordinates[coordinates.length - 1]
  if (projection?.runsOutAt && projectionEndMs != null && x > latest.x) {
    const time = Math.min(Math.max(timeAtX(x, domain), Date.parse(latest.fetchedAt)), projectionEndMs)
    const remaining = projectedRemainingAt(projection, time)
    return {
      kind: 'projection',
      at: new Date(time).toISOString(),
      remainingPercent: Math.round(remaining),
      x: xAtTime(time, domain),
      y: yAtValue(remaining, domain),
    }
  }
  let low = 0
  let high = coordinates.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (coordinates[middle].x < x) low = middle + 1
    else high = middle
  }
  const candidates = [coordinates[low], coordinates[low - 1]].filter(
    (point): point is ChartHoverPoint => point != null,
  )
  const nearest = candidates.reduce((best, point) =>
    Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best,
  )
  return {
    kind: 'history',
    at: nearest.fetchedAt,
    remainingPercent: nearest.totalRemainingPercent,
    x: nearest.x,
    y: nearest.y,
  }
}

export const INACTIVITY_MIN_MS = 60 * 60 * 1000

export interface InactivityStretch {
  fromAt: string
  toAt: string
  durationMs: number
}

/** Stretches where the total never decreased between consecutive points for at least minMs; a reset's rise is no spend. */
export function inactivityStretches(
  points: readonly { fetchedAt: string; totalRemainingPercent: number }[],
  { minMs = INACTIVITY_MIN_MS }: { minMs?: number } = {},
): InactivityStretch[] {
  const parsed = points
    .map((point) => ({ ...point, atMs: Date.parse(point.fetchedAt) }))
    .filter((point) => Number.isFinite(point.atMs))
    .sort((left, right) => left.atMs - right.atMs)
  const stretches: InactivityStretch[] = []
  let start: (typeof parsed)[number] | null = null
  const close = (end: (typeof parsed)[number]) => {
    if (start && end.atMs - start.atMs >= minMs) {
      stretches.push({ fromAt: start.fetchedAt, toAt: end.fetchedAt, durationMs: end.atMs - start.atMs })
    }
    start = null
  }
  for (let index = 1; index < parsed.length; index += 1) {
    const previous = parsed[index - 1]
    const current = parsed[index]
    const spent = previous.totalRemainingPercent - current.totalRemainingPercent > 0
    if (spent) close(previous)
    else if (!start) start = previous
  }
  if (parsed.length > 0) close(parsed[parsed.length - 1])
  return stretches
}

/** The stretch a moment falls in, or null. */
export function stretchAt(stretches: readonly InactivityStretch[], atMs: number) {
  return (
    stretches.find(
      (stretch) => Date.parse(stretch.fromAt) <= atMs && atMs <= Date.parse(stretch.toAt),
    ) ?? null
  )
}

/** "2d 4h", "3h 20m", "45m". */
export function formatSpanShort(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
