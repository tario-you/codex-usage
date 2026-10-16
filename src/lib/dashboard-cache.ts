// The dashboard paints the owner's last-seen accounts and chart at once, while the fresh read runs, instead of
// "0 accounts · synced never" and empty rows for the seconds a read takes from abroad. The header's "synced" time
// comes from the rows themselves, so a cached paint never passes an old reading off as new. Signing out clears it.

const PREFIX = 'codex-usage.dashboard-cache.'

type CacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

function storage(): CacheStorage | null {
  try {
    // globalThis, not window: the Node type check reads this file through its test, without DOM types.
    return (globalThis as { localStorage?: CacheStorage }).localStorage ?? null
  } catch {
    return null
  }
}

export function readDashboardCache<T>(key: string, store: CacheStorage | null = storage()): { at: number; data: T } | undefined {
  try {
    const parsed = JSON.parse(store?.getItem(PREFIX + key) ?? 'null')
    return parsed && typeof parsed.at === 'number' && parsed.data !== undefined ? parsed : undefined
  } catch {
    return undefined
  }
}

export function writeDashboardCache<T>(key: string, data: T, store: CacheStorage | null = storage(), now = Date.now()) {
  try {
    store?.setItem(PREFIX + key, JSON.stringify({ at: now, data }))
  } catch {
    // A full or blocked storage only costs the instant paint.
  }
}

export function clearDashboardCache(store: CacheStorage | null = storage()) {
  if (!store) return
  const keys: string[] = []
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index)
    if (key?.startsWith(PREFIX)) keys.push(key)
  }
  for (const key of keys) store.removeItem(key)
}

/** Query options that start from the cached answer, dated when it was read, and keep the cache current. */
export function cachedQuery<T>(key: string | null, queryFn: () => Promise<T>) {
  return {
    queryFn: async () => {
      const data = await queryFn()
      if (key) writeDashboardCache(key, data)
      return data
    },
    initialData: () => (key ? readDashboardCache<T>(key)?.data : undefined),
    initialDataUpdatedAt: () => (key ? readDashboardCache<T>(key)?.at : undefined),
  }
}
