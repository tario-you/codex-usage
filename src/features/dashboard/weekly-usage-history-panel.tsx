import { useState, type PointerEvent } from 'react'
import type { DashboardAccountRow, DashboardWeeklyUsageHistoryPoint } from '../../lib/dashboard'
import { formatRelativeTimestamp } from '../../shared/codex'
import { dashboardWeeklyUsageRanges, type DashboardWeeklyUsageRange } from './usage-history-ranges'
import { buildProviderSeries, DEFAULT_USAGE_VISIBILITY, USAGE_PROVIDERS, type UsageProviderSeries } from './usage-provider-series'
import { buildWeeklyUsageChart, formatHistoryTooltipTimestamp as timestamp } from './weekly-usage-chart'
import { readingAtX } from './usage-history-hover'

export function WeeklyUsageHistoryPanel({ accounts, errorMessage, isLoading, onRangeChange, points, range }: {
  accounts: DashboardAccountRow[]
  errorMessage: string | null
  isLoading: boolean
  onRangeChange: (range: DashboardWeeklyUsageRange) => void
  points: DashboardWeeklyUsageHistoryPoint[]
  range: DashboardWeeklyUsageRange
}) {
  const [visible, setVisible] = useState(DEFAULT_USAGE_VISIBILITY)
  const series = buildProviderSeries(points, accounts, visible)
  return (
    <section className="border-b border-border px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p className="font-medium text-foreground">Weekly remaining</p>
          <div role="group" aria-label="Usage providers" className="flex gap-3">
            {USAGE_PROVIDERS.map((provider) => (
              <label key={provider.key} className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={visible[provider.key]}
                  style={{ accentColor: provider.color }}
                  onChange={(event) => setVisible((previous) => ({ ...previous, [provider.key]: event.target.checked }))} />
                <span aria-hidden="true" className="inline-block h-0.5 w-4" style={{ backgroundColor: provider.color }} />
                {provider.label}
              </label>
            ))}
          </div>
        </div>
        <div aria-label="History range" className="inline-flex rounded-lg border border-border bg-background p-0.5" role="group">
          {dashboardWeeklyUsageRanges.map((option) => (
            <button key={option.value} aria-pressed={option.value === range} type="button"
              className={`h-6 rounded-md px-2 text-xs font-medium ${option.value === range ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => onRangeChange(option.value)}>{option.label}</button>
          ))}
        </div>
      </div>
      {series.map((item) => {
        const latest = item.points.at(-1)
        const projection = item.projection
        return (
          <p key={item.key} className="mt-1 text-sm text-muted-foreground">
            <span className="font-medium" style={{ color: item.color }}>{item.label}</span>{' · '}
            {latest ? `${latest.totalRemainingPercent}% left of ${item.capacityPercent}% · Updated ${formatRelativeTimestamp(latest.fetchedAt)}` : isLoading ? 'Loading sync history…' : 'No sync history in this range.'}
            {projection ? ` · ${projection.percentPerHour}%/h recent pace · ${projection.runsOutAt ? `first empty ${timestamp(projection.runsOutAt)}` : `no depletion projected through ${timestamp(projection.endAt!)}`} · ${projection.resets?.length ?? 0} reported resets included` : ''}
          </p>
        )
      })}
      {series.some((item) => item.projection) ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Dashed: 7-day estimate from latest sync, using soonest-reset plans first. Jumps: weekly refills.
          Only reported resets included; session limits and sign-in availability may limit use.
        </p>
      ) : null}
      {errorMessage ? <p role="alert" className="mt-2 text-sm text-destructive">{errorMessage}</p>
        : series.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Select Codex or Claude to show usage.</p>
        : series.some((item) => item.points.length) ? <ProviderUsageChart series={series} range={range} />
        : isLoading ? <div className="mt-2 h-28 animate-pulse rounded-md bg-muted" />
        : <p className="py-6 text-center text-sm text-muted-foreground">No points to plot.</p>}
    </section>
  )
}

function ProviderUsageChart({ series, range }: { series: UsageProviderSeries[]; range: DashboardWeeklyUsageRange }) {
  const [hoverX, setHoverX] = useState<number | null>(null)
  const nowMs = Math.max(...series.flatMap((item) => item.points.map((point) => Date.parse(point.fetchedAt))))
  const domainEndMs = Math.max(nowMs, ...series.map((item) => Date.parse(item.projection?.endAt ?? '') || 0))
  const capacity = Math.max(100, ...series.flatMap((item) => [item.capacityPercent, ...item.points.flatMap((point) => [point.totalRemainingPercent, point.totalCapacityPercent])]))
  const charts = series.filter((item) => item.points.length).map((item) => ({
    ...item,
    chart: buildWeeklyUsageChart(item.points, range, capacity, item.projection, { nowMs, domainEndMs }),
  }))
  const axes = charts[0].chart
  const readings = charts.flatMap((item) => {
    const reading = hoverX == null ? null : readingAtX(hoverX, {
      coordinates: item.chart.coordinates, domain: item.chart.domain,
      projection: item.projection, projectionEndMs: item.chart.projectionEndMs,
    })
    return reading ? [{ ...item, reading }] : []
  })
  const pointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width > 0) setHoverX((event.clientX - rect.left) / rect.width * 1000)
  }
  return (
    <div className="relative mt-2 overflow-hidden rounded-md border border-border bg-background">
      <svg aria-label="Weekly remaining by provider" role="img" viewBox="0 0 1000 112" className="h-auto w-full"
        onPointerMove={pointer} onPointerDown={pointer} onPointerLeave={() => setHoverX(null)}>
        <title>Weekly remaining by provider</title>
        {axes.yTicks.map((tick) => (
          <g key={tick.value}>
            <line stroke="var(--border)" x1={axes.bounds.left} x2={axes.bounds.right} y1={tick.y} y2={tick.y} />
            <text fill="var(--muted-foreground)" fontSize="10" textAnchor="end" x={axes.bounds.left - 8} y={tick.y + 4}>{tick.value}%</text>
          </g>
        ))}
        <line stroke="var(--border)" x1={axes.bounds.left} x2={axes.bounds.left} y1={axes.bounds.top} y2={axes.bounds.bottom} />
        {axes.nowX != null ? <line stroke="var(--border)" strokeDasharray="2 4" x1={axes.nowX} x2={axes.nowX} y1={axes.bounds.top} y2={axes.bounds.bottom} /> : null}
        {charts.map(({ key, label, color, chart }) => (
          <g key={key} aria-label={`${label} usage`}>
            {charts.length === 1 ? chart.inactivity.map((stretch) => (
              <rect key={stretch.fromAt} fill="var(--muted-foreground)" opacity="0.1" x={stretch.x} width={stretch.width} y={axes.bounds.top} height={axes.bounds.bottom - axes.bounds.top}>
                <title>{`${label}: no spend from ${timestamp(stretch.fromAt)} to ${timestamp(stretch.toAt)}`}</title>
              </rect>
            )) : null}
            {charts.length === 1 && chart.areaPath ? <path d={chart.areaPath} fill={color} opacity="0.08" /> : null}
            <path data-provider={key} d={chart.linePath} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {chart.projectionPath ? <path data-forecast={key} d={chart.projectionPath} fill="none" stroke={color} strokeWidth="2" strokeDasharray="5 5" opacity="0.75" /> : null}
            {chart.resetDots.map((reset, index) => (
              <circle key={`${reset.at}-${index}`} cx={reset.x} cy={reset.y} r="3" fill="var(--background)" stroke={color} strokeWidth="1.5">
                <title>{`${label}: ${reset.label} resets ${timestamp(reset.at)}: +${Math.round(reset.addedPercent)}% projected`}</title>
              </circle>
            ))}
            {chart.runOutDot ? <circle cx={chart.runOutDot.x} cy={chart.runOutDot.y} r="3.5" fill="var(--background)" stroke={color} strokeWidth="2"><title>{`${label}: first empty ${chart.runOutDot.label}`}</title></circle> : null}
            {chart.pointsForDots.map((point) => <circle key={point.fetchedAt} cx={point.x} cy={point.y} r="2" fill={color}><title>{`${label}: ${point.totalRemainingPercent}% at ${timestamp(point.fetchedAt)}`}</title></circle>)}
          </g>
        ))}
        {charts.length === 1 && axes.inactivity.length > 0 ? <text fill="var(--muted-foreground)" fontSize="9" textAnchor="end" x={axes.bounds.right} y={axes.bounds.top - 2}>shaded: no spend</text> : null}
        {readings.map(({ key, color, reading }) => (
          <g key={key}>
            <line stroke={color} opacity="0.4" strokeDasharray="3 3" x1={reading.x} x2={reading.x} y1={axes.bounds.top} y2={axes.bounds.bottom} />
            <circle cx={reading.x} cy={reading.y} r="4" fill={color} stroke="var(--background)" strokeWidth="2" />
          </g>
        ))}
        {axes.xTicks.map((tick) => <text key={`${tick.x}-${tick.label}`} fill="var(--muted-foreground)" fontSize="10" textAnchor={tick.anchor} x={tick.x} y={axes.bounds.bottom + 16}>{tick.label}</text>)}
      </svg>
      {readings.length > 0 ? (
        <div className="pointer-events-none absolute top-2 z-10 max-w-[90%] rounded-md border border-border bg-background px-2 py-1 text-xs shadow-md"
          style={hoverX! > 500 ? { right: '1%' } : { left: '6%' }}>
          {readings.map(({ key, color, label, capacityPercent, reading }) => (
            <p key={key}><span style={{ color }}>{label}</span>: {reading.kind === 'projection' ? '~' : ''}{reading.remainingPercent}% of {capacityPercent}%{reading.kind === 'projection' ? ' (projected)' : ''} · {timestamp(reading.at)}</p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
