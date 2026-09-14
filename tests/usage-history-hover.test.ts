import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatSpanShort,
  inactivityStretches,
  readingAtX,
  stretchAt,
  timeAtX,
  xAtTime,
} from '../src/features/dashboard/usage-history-hover'
import { projectRunOut } from '../src/features/dashboard/usage-projection'

const T0 = Date.parse('2026-09-14T00:00:00.000Z')
const HOUR = 60 * 60 * 1000
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString()
// A 10-hour axis from T0 to T0+10h across x 100..1000, with the newest point at 6h and 4h of projection.
const domain = { bottom: 88, domainEndMs: T0 + 10 * HOUR, left: 100, right: 1000, startMs: T0, top: 10, yMax: 1000 }
const coordinates = [0, 2, 4, 6].map((hours) => ({
  fetchedAt: at(hours),
  totalRemainingPercent: 500 - hours * 50,
  x: xAtTime(T0 + hours * HOUR, domain),
  y: 0,
}))

// #35: the pointer names the nearest point, or the projection past the newest one.
test('the reading is the nearest history point by x, at the edges too', () => {
  assert.equal(readingAtX(0, { coordinates, domain })?.at, at(0), 'before the first point')
  assert.equal(readingAtX(xAtTime(T0 + 2.9 * HOUR, domain), { coordinates, domain })?.at, at(2), 'closer to 2h than 4h')
  assert.equal(readingAtX(xAtTime(T0 + 3.2 * HOUR, domain), { coordinates, domain })?.at, at(4), 'closer to 4h than 2h')
  const last = readingAtX(1000, { coordinates, domain })
  assert.equal(last?.at, at(6), 'past the newest point with no projection is the newest point')
  assert.equal(last?.kind, 'history')
  assert.equal(last?.remainingPercent, 200)
  assert.equal(readingAtX(500, { coordinates: [], domain }), null)
})

test('past the newest point the reading follows the projection and stops at its end', () => {
  const projection = projectRunOut(coordinates)
  assert.ok(projection && projection.runsOutAt)
  const projectionEndMs = T0 + 9 * HOUR
  const mid = readingAtX(xAtTime(T0 + 8 * HOUR, domain), { coordinates, domain, projection, projectionEndMs })
  assert.equal(mid?.kind, 'projection')
  assert.equal(mid?.at, at(8))
  assert.equal(mid?.remainingPercent, 100, '200% at 50%/h two hours later')
  const clamped = readingAtX(1000, { coordinates, domain, projection, projectionEndMs })
  assert.equal(clamped?.at, at(9), 'never past the projection end')
  assert.equal(timeAtX(xAtTime(T0 + 5 * HOUR, domain), domain), T0 + 5 * HOUR, 'x and time round-trip')
})

// #36: stretches of no spend are shaded; a reset's rise is no spend, a drop ends the stretch.
test('inactivity stretches are flat or rising runs of at least an hour', () => {
  const points = [
    { fetchedAt: at(0), totalRemainingPercent: 500 },
    { fetchedAt: at(0.25), totalRemainingPercent: 500 },
    { fetchedAt: at(0.5), totalRemainingPercent: 480 }, // spend ends a short (30 min) flat run: dropped
    { fetchedAt: at(1), totalRemainingPercent: 480 },
    { fetchedAt: at(2), totalRemainingPercent: 480 },
    { fetchedAt: at(3), totalRemainingPercent: 1600 }, // a reset rise keeps the stretch going
    { fetchedAt: at(4), totalRemainingPercent: 1600 },
    { fetchedAt: at(4.5), totalRemainingPercent: 1500 }, // spend
    { fetchedAt: at(5), totalRemainingPercent: 1400 },
    { fetchedAt: at(7), totalRemainingPercent: 1400 },
  ]
  const stretches = inactivityStretches(points)
  assert.deepEqual(
    stretches.map((stretch) => [stretch.fromAt, stretch.toAt, stretch.durationMs / HOUR]),
    [
      [at(0.5), at(4), 3.5],
      [at(5), at(7), 2],
    ],
  )
  assert.equal(stretchAt(stretches, T0 + 2 * HOUR)?.fromAt, at(0.5))
  assert.equal(stretchAt(stretches, T0 + 4.75 * HOUR), null, 'an active moment is in no stretch')
  assert.deepEqual(inactivityStretches([{ fetchedAt: at(0), totalRemainingPercent: 5 }]), [])
})

test('spans read as days, hours, or minutes', () => {
  assert.equal(formatSpanShort(45 * 60000), '45m')
  assert.equal(formatSpanShort(3 * HOUR + 20 * 60000), '3h 20m')
  assert.equal(formatSpanShort(2 * 24 * HOUR + 4 * HOUR), '2d 4h')
})
