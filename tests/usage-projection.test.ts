import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROJECTION_PACE_WINDOW_MS,
  nextWeeklyReset,
  projectRunOut,
  projectedRemainingAt,
} from '../src/features/dashboard/usage-projection'

const T0 = Date.parse('2026-09-14T00:00:00.000Z')
const HOUR = 60 * 60 * 1000
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString()

// #33: the projection reads the spend pace from the recent points and says
// when the total reaches zero at that pace.
test('a steady decline projects the run-out from the newest point at that pace', () => {
  const projection = projectRunOut([
    { fetchedAt: at(0), totalRemainingPercent: 500 },
    { fetchedAt: at(2), totalRemainingPercent: 400 },
    { fetchedAt: at(4), totalRemainingPercent: 300 },
    { fetchedAt: at(6), totalRemainingPercent: 200 },
  ])
  assert.ok(projection)
  assert.equal(projection.percentPerHour, 50)
  assert.equal(projection.spentPercent, 300)
  assert.equal(projection.fromAt, at(6))
  assert.equal(projection.runsOutAt, at(10), '200% at 50%/h runs out four hours after the newest point')
  assert.equal(projectedRemainingAt(projection, T0 + 8 * HOUR), 100)
  assert.equal(projectedRemainingAt(projection, T0 + 20 * HOUR), 0, 'never below zero')
})

test('a plan reset inside the window is not negative spend', () => {
  const projection = projectRunOut([
    { fetchedAt: at(0), totalRemainingPercent: 100 },
    { fetchedAt: at(1), totalRemainingPercent: 50 },
    { fetchedAt: at(2), totalRemainingPercent: 1600 },
    { fetchedAt: at(3), totalRemainingPercent: 1550 },
  ])
  assert.ok(projection)
  assert.equal(projection.spentPercent, 100, 'only the two drops count')
  assert.equal(projection.percentPerHour, 33.33)
  assert.ok(projection.runsOutAt && Date.parse(projection.runsOutAt) > T0 + 40 * HOUR)
})

test('no spend in the window means no run-out, and one point is no pace at all', () => {
  const flat = projectRunOut([
    { fetchedAt: at(0), totalRemainingPercent: 800 },
    { fetchedAt: at(5), totalRemainingPercent: 800 },
  ])
  assert.ok(flat)
  assert.equal(flat.percentPerHour, 0)
  assert.equal(flat.runsOutAt, null)
  assert.equal(projectRunOut([{ fetchedAt: at(0), totalRemainingPercent: 800 }]), null)
  assert.equal(projectRunOut([]), null)
})

test('the pace window is the last day before the newest point; older points do not pull the pace', () => {
  const projection = projectRunOut([
    { fetchedAt: at(-60), totalRemainingPercent: 1600 },
    { fetchedAt: at(-30), totalRemainingPercent: 600 },
    { fetchedAt: at(-1), totalRemainingPercent: 100 },
    { fetchedAt: at(0), totalRemainingPercent: 90 },
  ])
  assert.ok(projection)
  assert.equal(PROJECTION_PACE_WINDOW_MS, 24 * HOUR)
  assert.equal(projection.spentPercent, 10, 'only the drop inside the last day')
  assert.equal(projection.percentPerHour, 10)
  assert.equal(projection.runsOutAt, at(9))
})

test('with fewer than two points in the window the pace falls back to the two newest points', () => {
  const projection = projectRunOut([
    { fetchedAt: at(-72), totalRemainingPercent: 1000 },
    { fetchedAt: at(0), totalRemainingPercent: 280 },
  ])
  assert.ok(projection)
  assert.equal(projection.percentPerHour, 10)
  assert.equal(projection.runsOutAt, at(28))
})

test('the next weekly reset is the earliest future 10080-minute window across the plans', () => {
  const row = (label: string, resetsAt: string | null, mins: number | null = 10080) => ({
    label,
    primary_remaining_percent: null, primary_resets_at: null, primary_used_percent: null, primary_window_mins: 300,
    secondary_remaining_percent: 40, secondary_resets_at: resetsAt, secondary_used_percent: 60, secondary_window_mins: mins,
  })
  const next = nextWeeklyReset(
    [row('later', at(120)), row('soonest', at(30)), row('past', at(-1)), row('five-hour', at(1), 300), row('none', null)],
    T0,
  )
  assert.deepEqual(next, { at: at(30), label: 'soonest' })
  assert.equal(nextWeeklyReset([row('past', at(-1))], T0), null)
})
