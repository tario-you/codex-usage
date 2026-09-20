import assert from 'node:assert/strict'
import test from 'node:test'
import { weeklyPlanCapacity } from '../src/features/dashboard/usage-plan-capacity'
import { forecastWeeklyUsage } from '../src/features/dashboard/usage-forecast'
import { projectRunOut, projectedRemainingAt } from '../src/features/dashboard/usage-projection'
import { buildProviderSeries } from '../src/features/dashboard/usage-provider-series'

const T0 = Date.parse('2026-09-20T00:00:00Z')
const at = h => new Date(T0 + h * 3600000).toISOString()
const account = (plan_type, remaining, reset, account_key = 'codex:fixture') => ({
  account_key, plan_type, label: plan_type,
  primary_remaining_percent: null, primary_used_percent: null, primary_window_mins: null, primary_resets_at: null,
  secondary_remaining_percent: remaining, secondary_used_percent: 100 - remaining,
  secondary_window_mins: 10080, secondary_resets_at: at(reset),
})
const point = (h, remaining, capacity) => ({ provider: 'codex', fetchedAt: at(h), totalRemainingPercent: remaining, totalCapacityPercent: capacity, accountCount: 1 })

test('the specified 4:1 ratio applies only to Codex ProLite; other plan weights remain unchanged', () => {
  assert.equal(weeklyPlanCapacity(account('pro', 100, 1)), 100)
  assert.equal(weeklyPlanCapacity(account(' PROLITE ', 100, 1)), 25)
  assert.equal(weeklyPlanCapacity(account(null, 100, 1)), 100)
  assert.equal(weeklyPlanCapacity(account('prolite', 100, 1, 'claude:fixture')), 100)
})

test('four full ProLite accounts have the same capacity and balance as one full Pro', () => {
  const lite = buildProviderSeries([point(0, 100, 100)], Array.from({ length: 4 }, () => account('prolite', 100, 1)), { codex: true, claude: false })[0]
  const pro = buildProviderSeries([point(0, 100, 100)], [account('pro', 100, 1)], { codex: true, claude: false })[0]
  assert.equal(lite.capacityPercent, pro.capacityPercent)
  const single = buildProviderSeries([point(0, 12.5, 25)], [account('prolite', 50, 1)], { codex: true, claude: false })[0]
  assert.equal(single.capacityPercent, 25)
})

test('weighted ProLite balance and reset refill stay in Pro units without a phantom allowance bucket', () => {
  const result = forecastWeeklyUsage([point(-1, 25, 25), point(0, 12.5, 25)], [account('prolite', 50, 0.5)])
  assert.ok(result)
  assert.equal(result.percentPerHour, 12.5)
  assert.deepEqual(result.timeline.filter(p => p.at === at(0.5)).map(p => p.remainingPercent), [6.25, 25])
  assert.equal(result.resets[0].addedPercent, 18.75)
  assert.equal(result.runsOutAt, at(2.5))
  assert.equal(projectedRemainingAt(result, T0 + 3600000), 18.75)
})

test('mixed pools spend weighted balances and refill each plan to its own capacity', () => {
  const result = forecastWeeklyUsage([point(-1, 135, 150), point(0, 125, 150)], [
    account('pro', 100, 20), account('prolite', 50, 1), account('prolite', 50, 2),
  ])
  assert.ok(result)
  assert.equal(result.percentPerHour, 10)
  assert.deepEqual(result.resets.slice(0, 2).map(r => r.addedPercent), [22.5, 22.5])
  assert.equal(result.timeline.findLast(p => p.at === at(2)).remainingPercent, 150)
  assert.equal(result.runsOutAt, at(17))
})

test('plan capacity changes are not mistaken for spending', () => {
  const result = projectRunOut([point(-2, 100, 100), point(-1, 25, 25), point(0, 20, 25)])
  assert.equal(result.spentPercent, 5)
  assert.equal(result.percentPerHour, 2.5)
})
