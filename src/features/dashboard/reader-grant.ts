// her-team#5389: Samantha for Mac's page asks to show this dashboard. Its link lands here with where to go back
// to and its own state; both wait in this tab's session storage through a Google sign-in, until Allow or Not now.
export const READER_RETURN_PARAM = 'samantha_return'
export const READER_STATE_PARAM = 'samantha_state'
const STORAGE_KEY = 'codex-usage.samantha-reader'

export interface PendingReaderGrant {
  returnTo: string
  state: string
}

type SessionStore = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

/** The request in the URL (kept, and taken out of the address bar) or the one kept earlier in this tab. */
export function takePendingReaderGrant(href: string, store: SessionStore | null, replace: (url: string) => void): PendingReaderGrant | null {
  const url = new URL(href)
  const returnTo = url.searchParams.get(READER_RETURN_PARAM)
  const state = url.searchParams.get(READER_STATE_PARAM)
  if (returnTo && state) {
    const pending = { returnTo, state }
    try { store?.setItem(STORAGE_KEY, JSON.stringify(pending)) } catch { /* the request still shows in this page */ }
    url.searchParams.delete(READER_RETURN_PARAM)
    url.searchParams.delete(READER_STATE_PARAM)
    replace(url.toString())
    return pending
  }
  try {
    const kept = JSON.parse(store?.getItem(STORAGE_KEY) ?? 'null')
    return typeof kept?.returnTo === 'string' && typeof kept?.state === 'string' ? { returnTo: kept.returnTo, state: kept.state } : null
  } catch {
    return null
  }
}

export function clearPendingReaderGrant(store: SessionStore | null) {
  try { store?.removeItem(STORAGE_KEY) } catch { /* nothing kept */ }
}

/** The host Samantha's page is on, for the card's words. */
export function readerHost(returnTo: string) {
  try { return new URL(returnTo).host } catch { return null }
}
