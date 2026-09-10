import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSwitchEventUpload } from '../bin/lib/switch-events.js'
import {
  describeSwitchEvent,
  groupSwitchEvents,
  switchEventDedupeKey,
  type SwitchEventView,
} from '../src/shared/switch-history'

const view = (partial: Partial<SwitchEventView> & Pick<SwitchEventView, 'id' | 'kind' | 'occurredAt'>): SwitchEventView => ({
  fromEmail: null, label: 'Mac', reason: null, source: 'device', toEmail: null, ...partial,
})

test('continuations within a minute fold into the switch they followed, newest first', () => {
  const groups = groupSwitchEvents([
    view({ id: 'r1', kind: 'resumed', occurredAt: '2026-09-10T00:23:23Z' }),
    view({ id: 's', kind: 'switched', fromEmail: 'a@x', toEmail: 'b@x', occurredAt: '2026-09-10T00:23:20Z' }),
    view({ id: 'r2', kind: 'resumed', occurredAt: '2026-09-10T00:23:24Z' }),
    view({ id: 'l', kind: 'relaunched', occurredAt: '2026-09-09T22:42:07Z' }),
    view({ id: 'late', kind: 'resumed', occurredAt: '2026-09-10T00:30:00Z' }),
  ])
  assert.deepEqual(groups.map((g) => [g.id, g.resumedCount]), [['late', 0], ['s', 2], ['l', 0]])
  assert.equal(describeSwitchEvent(groups[1]), 'a@x → b@x')
  assert.equal(describeSwitchEvent(groups[2]), 'Codex relaunched with the switcher')
})

test('the dedupe key is stable across re-uploads', () => {
  const key = switchEventDedupeKey({ source: 'device', sourceId: 'd1', kind: 'switched', occurredAt: '2026-09-10T00:23:20.000Z' })
  assert.equal(key, switchEventDedupeKey({ source: 'device', sourceId: 'd1', kind: 'switched', occurredAt: '2026-09-10T00:23:20+00:00' }))
  assert.notEqual(key, switchEventDedupeKey({ source: 'grant', sourceId: 'd1', kind: 'switched', occurredAt: '2026-09-10T00:23:20.000Z' }))
})

test('the owner upload maps Switchboard activity, tracks the previous account, and honours the watermark', () => {
  const entries = [
    { type: 'switched', accountId: 'A', message: 'Switched to an available account', at: '2026-09-10T00:10:00.000Z' },
    { type: 'resumed', accountId: null, message: 'Task resumed after quota exhaustion', at: '2026-09-10T00:10:02.000Z' },
    { type: 'needs-login', accountId: 'B', message: 'Provider requires a fresh sign-in', at: '2026-09-10T00:11:00.000Z' },
    { type: 'switched', accountId: 'B', message: 'Switched to an available account', at: '2026-09-10T00:23:20.000Z' },
    { type: 'desktop-relaunched', accountId: null, message: 'Codex desktop now runs through the switching wrapper', at: '2026-09-10T00:30:00.000Z' },
  ]
  const emails = new Map([['A', 'a@x'], ['B', 'b@x']])
  const all = buildSwitchEventUpload({ entries, emailsById: emails, uploadedAt: null })
  assert.deepEqual(all.map((e) => [e.kind, e.fromEmail, e.toEmail]), [
    ['switched', null, 'a@x'], ['resumed', null, null], ['switched', 'a@x', 'b@x'], ['relaunched', null, null],
  ])
  const later = buildSwitchEventUpload({ entries, emailsById: emails, uploadedAt: '2026-09-10T00:10:02.000Z' })
  assert.deepEqual(later.map((e) => [e.kind, e.fromEmail]), [['switched', 'a@x'], ['relaunched', null]])
})
