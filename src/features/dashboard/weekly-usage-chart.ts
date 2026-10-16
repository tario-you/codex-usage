import type { DashboardWeeklyUsageHistoryPoint } from '../../lib/dashboard'
import { getDashboardWeeklyUsageRangeDays, type DashboardWeeklyUsageRange } from './usage-history-ranges'
import { projectedRemainingAt, type UsageProjection } from './usage-projection'
import { inactivityStretches, type ChartHoverDomain } from './usage-history-hover'

interface WeeklyUsageChartBounds {
  bottom: number
  left: number
  right: number
  top: number
}

interface WeeklyUsageChartPoint {
  fetchedAt: string
  totalRemainingPercent: number
  x: number
  y: number
}

export function buildWeeklyUsageChart(
  points: DashboardWeeklyUsageHistoryPoint[],
  range: DashboardWeeklyUsageRange,
  capacityPercent: number,
  projection: UsageProjection | null = null,
  clock = { nowMs: Date.now(), domainEndMs: 0 },
) {
  const bounds: WeeklyUsageChartBounds = {
    bottom: 200,
    left: 48,
    right: 988,
    top: 10,
  }
  const rangeMs =
    getDashboardWeeklyUsageRangeDays(range) * 24 * 60 * 60 * 1000
  const endMs = clock.nowMs
  const startMs = endMs - rangeMs
  const runsOutAtMs = projection?.runsOutAt ? Date.parse(projection.runsOutAt) : null
  const domainEndMs = Math.max(clock.domainEndMs, endMs, projection?.endAt ? Date.parse(projection.endAt) : 0)
  const horizonMs = domainEndMs - endMs
  const domainMs = domainEndMs - startMs
  const plotWidth = bounds.right - bounds.left
  const plotHeight = bounds.bottom - bounds.top
  const parsedPoints = points
    .map((point) => ({
      ...point,
      fetchedAtMs: Date.parse(point.fetchedAt),
    }))
    .filter((point) => Number.isFinite(point.fetchedAtMs))
    .sort((left, right) => left.fetchedAtMs - right.fetchedAtMs)
  const maxPointValue = parsedPoints.reduce(
    (maxValue, point) =>
      Math.max(maxValue, point.totalRemainingPercent, point.totalCapacityPercent),
    capacityPercent,
  )
  const yMax = Math.max(100, Math.ceil(maxPointValue / 100) * 100)
  const coordinates: WeeklyUsageChartPoint[] = parsedPoints.map((point) => {
    const clampedTime = Math.min(Math.max(point.fetchedAtMs, startMs), domainEndMs)
    const x = bounds.left + ((clampedTime - startMs) / domainMs) * plotWidth
    const y =
      bounds.bottom -
      (Math.min(Math.max(point.totalRemainingPercent, 0), yMax) / yMax) *
        plotHeight

    return {
      fetchedAt: point.fetchedAt,
      totalRemainingPercent: point.totalRemainingPercent,
      x: roundChartCoordinate(x),
      y: roundChartCoordinate(y),
    }
  })
  const linePath = refillPath(coordinates)
  // The effective line: weekly room on plans whose 5-hour window isn't spent, in the same units as the actual line.
  const effectiveCoordinates: WeeklyUsageChartPoint[] = parsedPoints.flatMap((point, index) =>
    point.effectiveRemainingPercent == null ? [] : [{
      fetchedAt: point.fetchedAt,
      totalRemainingPercent: point.effectiveRemainingPercent,
      x: coordinates[index].x,
      y: roundChartCoordinate(bounds.bottom - (Math.min(Math.max(point.effectiveRemainingPercent, 0), yMax) / yMax) * plotHeight),
    }])
  const effectivePath = effectiveCoordinates.length > 0 ? refillPath(effectiveCoordinates) : null
  const areaPath =
    coordinates.length > 0
      ? `${linePath} L ${coordinates[coordinates.length - 1].x} ${bounds.bottom} L ${coordinates[0].x} ${bounds.bottom} Z`
      : null
  const middleTick = Math.round(yMax / 2)
  const timeToX = (time: number) =>
    roundChartCoordinate(
      bounds.left +
        ((Math.min(Math.max(time, startMs), domainEndMs) - startMs) / domainMs) *
          plotWidth,
    )
  const valueToY = (value: number) =>
    roundChartCoordinate(
      bounds.bottom - (Math.min(Math.max(value, 0), yMax) / yMax) * plotHeight,
    )
  const projectionEndMs = projection?.endAt ? Date.parse(projection.endAt) : null
  const projectionPath = projection?.timeline
    ?.map((point, index) => `${index === 0 ? 'M' : 'L'} ${timeToX(Date.parse(point.at))} ${valueToY(point.remainingPercent)}`)
    .join(' ') ?? null
  const resetDots = (projection?.resets ?? []).map((reset) => ({
    ...reset,
    x: timeToX(Date.parse(reset.at)),
    y: valueToY(projectedRemainingAt(projection!, Date.parse(reset.at))),
  }))
  const runOutDot =
    projection && runsOutAtMs != null && projectionPath && runsOutAtMs <= domainEndMs
      ? {
          label: formatHistoryTooltipTimestamp(projection.runsOutAt ?? ''),
          x: timeToX(runsOutAtMs),
          y: valueToY(0),
        }
      : null
  // #36: stretches of no spend, shaded behind the line.
  const inactivity = inactivityStretches(parsedPoints).map((stretch) => {
    const x = timeToX(Date.parse(stretch.fromAt))
    return {
      ...stretch,
      width: Math.max(1, timeToX(Date.parse(stretch.toAt)) - x),
      x,
    }
  })
  const domain: ChartHoverDomain = {
    bottom: bounds.bottom,
    domainEndMs,
    left: bounds.left,
    right: bounds.right,
    startMs,
    top: bounds.top,
    yMax,
  }
  const xTickValues =
    horizonMs > 0
      ? [
          { anchor: 'start' as const, time: startMs },
          { anchor: 'middle' as const, time: endMs },
          { anchor: 'end' as const, time: domainEndMs },
        ]
      : [
          { anchor: 'start' as const, time: startMs },
          { anchor: 'middle' as const, time: startMs + rangeMs / 2 },
          { anchor: 'end' as const, time: endMs },
        ]

  return {
    areaPath,
    bounds,
    linePath,
    coordinates,
    domain,
    inactivity,
    nowX: horizonMs > 0 ? timeToX(endMs) : null,
    pointsForDots: coordinates.length <= 80 ? coordinates : [],
    effectiveCoordinates,
    effectivePath,
    projectionEndMs,
    projectionPath,
    runOutDot,
    resetDots,
    xTicks: xTickValues.map((tick) => ({
      anchor: tick.anchor,
      label: formatHistoryAxisTimestamp(tick.time, range),
      x:
        tick.anchor === 'start'
          ? bounds.left
          : tick.anchor === 'end'
            ? bounds.right
            : timeToX(tick.time),
    })),
    yTicks: [yMax, middleTick, 0].map((value) => ({
      value,
      y: roundChartCoordinate(bounds.bottom - (value / yMax) * plotHeight),
    })),
  }
}

/** Spend draws as a slope between readings; a refill (a rise) draws as a vertical jump at the reading that saw it. */
function refillPath(points: readonly { x: number; y: number }[]) {
  return points.map((point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`
    const previous = points[index - 1]
    return point.y < previous.y ? `L ${point.x} ${previous.y} L ${point.x} ${point.y}` : `L ${point.x} ${point.y}`
  }).join(' ')
}

function roundChartCoordinate(value: number) {
  return Math.round(value * 100) / 100
}

function formatHistoryAxisTimestamp(
  value: number,
  range: DashboardWeeklyUsageRange,
) {
  const formatter =
    range === '1d'
      ? new Intl.DateTimeFormat('en-US', {
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
        })
      : new Intl.DateTimeFormat('en-US', {
          day: 'numeric',
          month: 'short',
        })

  return formatter.format(new Date(value))
}

export function formatHistoryTooltipTimestamp(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown time'
  }

  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  }).format(parsed)
}

