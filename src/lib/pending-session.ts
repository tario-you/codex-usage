import type { Session } from '@supabase/supabase-js'

// A saved sign-in's token lasts an hour, so a return visit usually starts by refreshing it with Supabase Auth, a
// round trip of seconds from abroad. Meanwhile the dashboard paints from the saved session: same user, so the cached
// rows and chart show at once. Its tokens are blank, so nothing reaches our API or the tables with it; every
// token-gated read waits for the refreshed session. A sign-in redirect in the URL gets no pending session.
export function readPendingSession(store: Pick<Storage, 'getItem'> | null, storageKey: string, href: string): Session | null {
  try {
    const url = new URL(href)
    if (url.searchParams.has('code') || url.searchParams.has('token_hash') || /access_token|error_description/.test(url.hash)) {
      return null
    }
    const saved = JSON.parse(store?.getItem(storageKey) ?? 'null')
    if (!saved || typeof saved !== 'object' || typeof saved.user?.id !== 'string') return null
    return { ...saved, access_token: '', refresh_token: '' }
  } catch {
    return null
  }
}
