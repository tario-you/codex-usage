import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { DashboardAccountRow } from '../../lib/dashboard'
import { isClaudeAccountKey } from '../../shared/codex'
import { resolveBrowserLoginMethod } from './browser-login-method'
import { browserLoginUrl } from './browser-login-url'
import { useBrowserSessionMode } from './browser-session-mode'

const methodChanged = 'browser-login-method-changed'
function subscribeMethod(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener(methodChanged, onChange)
  return () => { window.removeEventListener('storage', onChange); window.removeEventListener(methodChanged, onChange) }
}

type BrowserDevice = { id: string; label: string; machine_name: string | null }

export function AccountBrowserLink({ account, session, children, hasGoogleCredential = false }: {
  account: DashboardAccountRow; session: Session; children: ReactNode; hasGoogleCredential?: boolean
}) {
  const [browserMode] = useBrowserSessionMode(session.user?.id)
  const storageKey = `browser-login-method:${session.user?.id}:${account.id}`
  const savedMethod = useSyncExternalStore(subscribeMethod, () => {
    try { return localStorage.getItem(storageKey) } catch { return null }
  }, () => null)
  const [temporaryMethod, setTemporaryMethod] = useState<string | null>(null)
  const loginMethod = resolveBrowserLoginMethod(savedMethod ?? temporaryMethod, hasGoogleCredential)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [devices, setDevices] = useState<BrowserDevice[]>([])
  const provider = isClaudeAccountKey(account.account_key) ? 'Claude' : 'ChatGPT'
  const call = async (route = '', body?: object) => {
    const response = await fetch(`/api/login/browser${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? 'Unable to open account.')
    return data
  }
  async function launch(device: BrowserDevice) {
    setDevices([])
    setBusy(true)
    setMessage(`Opening ${provider} on ${device.label || device.machine_name || 'your machine'}…`)
    try {
      const { requestId } = await call('', { accountId: account.id, deviceId: device.id, loginMethod })
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        const { state } = await call(`?requestId=${encodeURIComponent(requestId)}`)
        if (state === 'opened') {
          setMessage(loginMethod === 'google'
            ? `Opened on ${device.label || device.machine_name || 'your machine'}. ${provider === 'Claude' ? 'Choose Continue with Google in Claude.' : 'Continue with Google using ' + account.email + '.'}`
            : `Opened on ${device.label || device.machine_name || 'your machine'} with ${account.email} prefilled. Finish signing in if prompted.`)
          return
        }
        if (state === 'failed' || state === 'expired') throw new Error('Chrome could not open. Check the browser helper on that machine, then retry.')
      }
      setMessage('Still waiting for the browser helper. The request expires after 90 seconds.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to open account.') }
    finally { setBusy(false) }
  }
  async function click() {
    setBusy(true)
    setMessage('')
    try {
      const { devices: available } = await call() as { devices: BrowserDevice[] }
      if (available.length === 1) { await launch(available[0]); return }
      if (available.length > 1) { setDevices(available); setMessage('Choose the machine where Chrome should open.'); return }
      setMessage('Browser helper offline. On your Mac, run codex-usage browser-agent with the updated CLI.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to reach browser helper.') }
    finally { setBusy(false) }
  }
  if (account.access_scope !== 'owned' || !account.email) return <span>{children}</span>
  const currentBrowserUrl = browserLoginUrl(isClaudeAccountKey(account.account_key) ? 'claude' : 'codex', account.email, loginMethod)
  return (
    <span className="inline-flex min-w-0 flex-col items-start">
      <span className="inline-flex max-w-full items-baseline gap-2">
      {browserMode === 'current' ? <a href={currentBrowserUrl} target="_blank" rel="noopener noreferrer"
        className="min-w-0 truncate text-left font-medium text-foreground underline underline-offset-2"
        title={`Open ${provider} sign-in for ${account.email} in this browser profile.${provider === 'Claude' && loginMethod === 'google' ? ' Choose Continue with Google on Claude.' : ''} The provider may keep its current account.`}
        aria-label={`Open ${provider} sign-in for ${account.email}`}>{children}</a> : <button type="button" className="min-w-0 truncate text-left font-medium text-foreground underline underline-offset-2 disabled:opacity-60"
        title={`Open ${provider} in the Chrome session for ${account.email} using ${loginMethod === 'google' ? 'Google' : 'email'}. Sign in once on first use.`}
        aria-label={`Open ${provider} as ${account.email}`} disabled={busy} onClick={() => void click()}>{children}</button>}
      <select aria-label={`Sign-in method for ${provider} ${account.email}`} value={loginMethod} disabled={busy}
        title="Sign-in method; your choice is remembered on this browser. Google is the default when a Google credential is saved."
        className="shrink-0 bg-background text-xs font-normal text-muted-foreground"
        onChange={event => {
          const method = event.target.value
          setTemporaryMethod(method)
          try { localStorage.setItem(storageKey, method); window.dispatchEvent(new Event(methodChanged)) } catch { /* Choice still applies for this page. */ }
        }}>
        <option value="google">Google</option><option value="email">Email</option>
      </select>
      </span>
      {message ? <span role="status" className="mt-1 max-w-sm whitespace-normal text-xs font-normal text-muted-foreground">{message}</span> : null}
      {devices.length > 1 ? <span className="mt-1 flex flex-wrap gap-2">
        {devices.map(device => <button key={device.id} type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => void launch(device)}>{device.label || device.machine_name || 'Machine'}</button>)}
        <button type="button" className="text-xs text-muted-foreground" onClick={() => { setDevices([]); setMessage('') }}>Cancel</button>
      </span> : null}
    </span>
  )
}
