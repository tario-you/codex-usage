import assert from 'node:assert/strict'
import test from 'node:test'

import { cachedQuery, clearDashboardCache, readDashboardCache, writeDashboardCache } from '../src/lib/dashboard-cache'

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

test('a cached answer paints at once and the read starts once sign-in enables the query, however new the copy', async () => {
  const { QueryClient, QueryObserver } = await import('@tanstack/react-query')
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } })
  const store = memoryStorage()
  const previous = (globalThis as { localStorage?: unknown }).localStorage
  ;(globalThis as { localStorage?: unknown }).localStorage = store
  try {
    // Another open tab saved this a moment ago.
    writeDashboardCache('history.me.7d', [1], store, Date.now())
    let reads = 0
    const options = { queryKey: ['history'], ...cachedQuery<number[]>('history.me.7d', async () => { reads += 1; return [2] }) }
    const observer = new QueryObserver(client, { ...options, enabled: false })
    const unsubscribe = observer.subscribe(() => {})
    assert.deepEqual(observer.getCurrentResult().data, [1], 'the saved answer shows first')
    observer.setOptions({ ...options, enabled: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    unsubscribe()
    assert.equal(reads, 1, 'enabling the query after mount still reads at once')
  } finally {
    ;(globalThis as { localStorage?: unknown }).localStorage = previous
  }
})
