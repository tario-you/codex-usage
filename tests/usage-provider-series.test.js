import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProviderSeries, DEFAULT_USAGE_VISIBILITY } from '../src/features/dashboard/usage-provider-series'
import { buildWeeklyUsageChart } from '../src/features/dashboard/weekly-usage-chart'

const T0 = Date.parse('2026-09-20T00:00:00Z')
const at = (h) => new Date(T0 + h * 3600000).toISOString()
const points = [
  { provider: 'codex', fetchedAt: at(-1), totalRemainingPercent: 80, accountCount: 1, totalCapacityPercent: 100 },
  { provider: 'codex', fetchedAt: at(0), totalRemainingPercent: 70, accountCount: 1, totalCapacityPercent: 100 },
  { provider: 'claude', fetchedAt: at(-1), totalRemainingPercent: 20, accountCount: 1, totalCapacityPercent: 100 },
  { provider: 'claude', fetchedAt: at(0), totalRemainingPercent: 18, accountCount: 1, totalCapacityPercent: 100 },
]
const accounts = [
  { account_key: 'codex-account', label: 'Codex fixture', secondary_used_percent: 30, secondary_window_mins: 10080, secondary_resets_at: at(4) },
  { account_key: 'claude:fixture', label: 'Claude fixture', secondary_used_percent: 82, secondary_window_mins: 10080, secondary_resets_at: at(8) },
]

test('Codex blue is on and Claude orange is off by default; every toggle combination is independent', () => {
  const defaults = buildProviderSeries(points, accounts, DEFAULT_USAGE_VISIBILITY)
  assert.deepEqual(defaults.map(s => [s.key, s.color]), [['codex', '#3b82f6']])
  assert.deepEqual(buildProviderSeries(points, accounts, { codex: false, claude: true }).map(s => [s.key, s.color]), [['claude', '#f97316']])
  assert.equal(buildProviderSeries(points, accounts, { codex: true, claude: true }).length, 2)
  assert.deepEqual(buildProviderSeries(points, accounts, { codex: false, claude: false }), [])
})

test('each line uses only its provider history, pace, capacity, and resets', () => {
  const [codex, claude] = buildProviderSeries(points, accounts, { codex: true, claude: true })
  assert.deepEqual(codex.points.map(p => p.totalRemainingPercent), [80, 70])
  assert.deepEqual(claude.points.map(p => p.totalRemainingPercent), [20, 18])
  assert.equal(codex.capacityPercent, 100)
  assert.equal(claude.capacityPercent, 100)
  assert.equal(codex.projection?.percentPerHour, 10)
  assert.equal(claude.projection?.percentPerHour, 2)
  assert.deepEqual(codex.projection?.resets?.map(r => r.at), [at(4)])
  assert.deepEqual(claude.projection?.resets?.map(r => r.at), [at(8)])
})

test('overlaid charts share exact axes and each renders a refill jump', () => {
  const series = buildProviderSeries(points, accounts, { codex: true, claude: true })
  const charts = series.map(s => buildWeeklyUsageChart(s.points, '7d', 100, s.projection, { nowMs: T0, domainEndMs: T0 + 168 * 3600000 }))
  assert.deepEqual(charts[0].domain, charts[1].domain)
  assert.deepEqual(charts[0].xTicks, charts[1].xTicks)
  assert.notEqual(charts[0].linePath, charts[1].linePath)
  for (const chart of charts) {
    const reset = chart.resetDots[0]
    assert.ok(chart.projectionPath?.includes(`L ${reset.x} ${reset.y}`))
    assert.equal(chart.projectionPath?.split(`L ${reset.x} `).length, 3, 'two values at reset x draw a vertical refill')
  }
})

test('a provider without history does not borrow the other provider line', () => {
  const [claude] = buildProviderSeries(points.filter(p => p.provider === 'codex'), accounts, { codex: false, claude: true })
  assert.deepEqual(claude.points, [])
  assert.equal(claude.projection, null)
})

test('the rendered default chart exposes both toggles and draws only Codex', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { WeeklyUsageHistoryPanel } = await import('../src/features/dashboard/weekly-usage-history-panel')
  const html = renderToStaticMarkup(createElement(WeeklyUsageHistoryPanel, {
    accounts, points, range: '7d', isLoading: false, errorMessage: null, onRangeChange: () => {},
  }))
  assert.match(html, /data-provider="codex"/)
  assert.doesNotMatch(html, /data-provider="claude"/)
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2)
  assert.equal((html.match(/checked=""/g) ?? []).length, 1)
})
