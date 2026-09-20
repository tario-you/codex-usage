import { useSyncExternalStore } from 'react'

export type BrowserSessionMode = 'current' | 'separate'
const changed = 'browser-session-mode-changed'
const temporary = new Map<string, BrowserSessionMode>()
const storageKey = (userId: string | undefined) => `browser-session-mode:${userId ?? 'anonymous'}`

export function readBrowserSessionMode(userId: string | undefined): BrowserSessionMode {
  const key = storageKey(userId)
  if (temporary.has(key)) return temporary.get(key)!
  try { return localStorage.getItem(key) === 'separate' ? 'separate' : 'current' }
  catch { return 'current' }
}

export function setBrowserSessionMode(userId: string | undefined, mode: BrowserSessionMode) {
  const key = storageKey(userId)
  try { localStorage.setItem(key, mode); temporary.delete(key) }
  catch { temporary.set(key, mode) }
  window.dispatchEvent(new Event(changed))
}

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener(changed, onChange)
  return () => { window.removeEventListener('storage', onChange); window.removeEventListener(changed, onChange) }
}

export function useBrowserSessionMode(userId: string | undefined) {
  const mode = useSyncExternalStore(subscribe, () => readBrowserSessionMode(userId), () => 'current' as const)
  return [mode, (next: BrowserSessionMode) => setBrowserSessionMode(userId, next)] as const
}
