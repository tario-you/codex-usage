import assert from 'node:assert/strict'
import test from 'node:test'

import { clearDashboardCache, readDashboardCache, writeDashboardCache } from '../src/lib/dashboard-cache'

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() { return items.size },
  }
}

test('the dashboard paints its last answer at once, dated when it was read, and signing out clears it', () => {
  const store = memoryStorage()
  store.setItem('other-app', 'kept')
  assert.equal(readDashboardCache('accounts.me', store), undefined)
  writeDashboardCache('accounts.me', [{ id: 'row' }], store, 1_000)
  writeDashboardCache('history.me.7d', [], store, 2_000)
  assert.deepEqual(readDashboardCache('accounts.me', store), { at: 1_000, data: [{ id: 'row' }] })
  store.setItem('codex-usage.dashboard-cache.broken', '{not json')
  assert.equal(readDashboardCache('broken', store), undefined, 'a damaged entry only costs the instant paint')
  clearDashboardCache(store)
  assert.equal(store.length, 1)
  assert.equal(store.getItem('other-app'), 'kept')
})
