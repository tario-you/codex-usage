import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { DashboardAccountRow } from '../src/lib/dashboard.ts'
import { UsageWindowList } from '../src/features/dashboard/usage-window-list.tsx'

const NOW = Date.parse('2026-07-15T18:00:00.000Z')
const hoursFromNow = (hours: number) => new Date(NOW + hours * 60 * 60 * 1000).toISOString()

function row(primary: [number, string | null], secondary: [number, string | null]) {
  return {
    access_scope: 'owned',
    id: 'fixture',
    plan_type: 'max',
    primary_remaining_overridden: false,
    primary_remaining_percent: primary[0],
    primary_resets_at: primary[1],
    primary_used_percent: 100 - primary[0],
    primary_window_mins: 300,
    secondary_remaining_overridden: false,
    secondary_remaining_percent: secondary[0],
    secondary_resets_at: secondary[1],
    secondary_used_percent: 100 - secondary[0],
    secondary_window_mins: 10_080,
  } as unknown as DashboardAccountRow
}

const render = (account: DashboardAccountRow, showDetails = false) =>
  renderToStaticMarkup(createElement(UsageWindowList, {
    account,
    now: NOW,
    onSaveUsageOverride: async () => true,
    savingUsageOverride: null,
    showDetails,
  }))

test('a spent weekly window hides the 5-hour line in the plain view', () => {
  const html = render(row([88, hoursFromNow(2.5)], [0, hoursFromNow(121)]))
  assert.doesNotMatch(html, /5-hour/)
  assert.match(html, /Weekly/)
  assert.match(html, /0%/)
})

test('a passed reset shows a full, green window with no countdown', () => {
  const html = render(row([0, hoursFromNow(-0.2)], [0, hoursFromNow(-1)]))
  assert.match(html, /5-hour/)
  assert.equal(html.match(/100%/g)?.length, 2)
  assert.equal(html.match(/bg-emerald-500/g)?.length, 2)
  assert.doesNotMatch(html, /resets in/)
})

test('details keep the measured values so a manual correction edits them', () => {
  const html = render(row([88, hoursFromNow(2.5)], [0, hoursFromNow(-1)]), true)
  assert.match(html, /88%/)
  assert.match(html, /5-hour/)
})
