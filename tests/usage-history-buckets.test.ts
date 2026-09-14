import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dashboardWeeklyUsageRanges,
  getDashboardWeeklyUsageBucketSeconds,
  getDashboardWeeklyUsageRangeDays,
  POSTGREST_MAX_ROWS,
} from '../src/features/dashboard/usage-history-ranges'

// #31: one RPC row per snapshot timestamp overran the browser's 1000-row cap
// once every login synced on its own clock, and the chart ended on Sep 9.
test('every chart range asks for fewer points than the PostgREST row cap', () => {
  for (const range of dashboardWeeklyUsageRanges) {
    const points =
      (getDashboardWeeklyUsageRangeDays(range.value) * 24 * 60 * 60) /
      getDashboardWeeklyUsageBucketSeconds(range.value)
    assert.ok(
      points < POSTGREST_MAX_ROWS,
      `${range.label} would draw ${points} points, past the ${POSTGREST_MAX_ROWS}-row cap`,
    )
    assert.ok(
      points >= 200,
      `${range.label} would draw only ${points} points; the line should stay smooth`,
    )
  }
})

test('the buckets are five minutes, fifteen minutes and one hour for 1, 7 and 30 days', () => {
  assert.equal(getDashboardWeeklyUsageBucketSeconds('1d'), 5 * 60)
  assert.equal(getDashboardWeeklyUsageBucketSeconds('7d'), 15 * 60)
  assert.equal(getDashboardWeeklyUsageBucketSeconds('30d'), 60 * 60)
})
