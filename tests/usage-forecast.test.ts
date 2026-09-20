import assert from 'node:assert/strict'
import test from 'node:test'
import { forecastWeeklyUsage } from '../src/features/dashboard/usage-forecast'
import { projectedRemainingAt } from '../src/features/dashboard/usage-projection'
import { readingAtX } from '../src/features/dashboard/usage-history-hover'

const T0 = Date.parse('2026-09-20T00:00:00Z')
const HOUR = 3600000
const at = (h: number) => new Date(T0 + h * HOUR).toISOString()
const account = (remaining: number, reset: number | null) => ({
  label: 'Synthetic plan', primary_remaining_percent: null, primary_used_percent: null,
  primary_window_mins: 300, primary_resets_at: null,
  secondary_remaining_percent: remaining, secondary_used_percent: 100 - remaining,
  secondary_window_mins: 10080, secondary_resets_at: reset == null ? null : at(reset),
})
const forecast = (remaining: number, rate: number, accounts: ReturnType<typeof account>[]) => {
  const result = forecastWeeklyUsage([
    { fetchedAt: at(-1), totalRemainingPercent: remaining + rate },
    { fetchedAt: at(0), totalRemainingPercent: remaining },
  ], accounts)
  assert.ok(result)
  return result
}

test('a reset prevents the old straight-line depletion and adds a vertical refill', () => {
  const result = forecast(50, 1, [account(50, 40), account(0, 80)])
  assert.equal(result.runsOutAt, null)
  assert.equal(projectedRemainingAt(result, T0 + 50 * HOUR), 90)
  assert.deepEqual(result.timeline?.filter(p => p.at === at(40)).map(p => p.remainingPercent), [10, 100])
  assert.equal(result.resets?.[0].addedPercent, 90, 'refill to 100, not add 100')
  assert.equal(result.endAt, at(168))
})

test('first empty is retained even when a later reset restores allowance', () => {
  const result = forecast(20, 10, [account(20, 4)])
  assert.equal(result.runsOutAt, at(2))
  assert.equal(projectedRemainingAt(result, T0 + 3 * HOUR), 0)
  assert.equal(projectedRemainingAt(result, T0 + 4 * HOUR), 100)
  assert.equal(projectedRemainingAt(result, T0 + 5 * HOUR), 90)
})

test('simultaneous refills cap each account and spend follows earliest resets', () => {
  const result = forecast(180, 10, [account(100, 2), account(80, 2)])
  assert.equal(projectedRemainingAt(result, T0 + 2 * HOUR), 200)
  assert.deepEqual(result.resets?.map(p => p.addedPercent), [20, 20])
  assert.equal(result.runsOutAt, at(22))
  const ordered = forecast(100, 10, [account(50, 10), account(50, 2)])
  assert.equal(ordered.resets?.[0].addedPercent, 70)
})

test('zero pace still shows refills without forecasting depletion', () => {
  const result = forecast(50, 0, [account(50, 5)])
  assert.equal(result.runsOutAt, null)
  assert.equal(projectedRemainingAt(result, T0 + 6 * HOUR), 100)
})

test('missing, past, invalid and nonweekly resets never create refills', () => {
  const result = forecast(100, 10, [account(20, null), account(20, -1),
    { ...account(20, 1), secondary_resets_at: 'invalid' },
    { ...account(20, 1), secondary_window_mins: 300 }, account(20, 200)])
  assert.equal(result.resets?.length, 0)
  assert.equal(result.runsOutAt, at(10))
})

test('a refill exactly when allowance empties avoids a positive-duration gap', () => {
  assert.equal(forecast(20, 10, [account(20, 2)]).runsOutAt, at(12))
})

test('hover uses the reset-aware path even when there is no run-out', () => {
  const projection = forecast(50, 0, [account(50, 5)])
  const reading = readingAtX(60, {
    coordinates: [{ fetchedAt: at(0), totalRemainingPercent: 50, x: 0, y: 50 }],
    domain: { left: 0, right: 100, top: 0, bottom: 100, startMs: T0, domainEndMs: T0 + 10 * HOUR, yMax: 100 },
    projection, projectionEndMs: T0 + 168 * HOUR,
  })
  assert.equal(reading?.kind, 'projection')
  assert.equal(reading?.remainingPercent, 100)
})
