import { useBrowserSessionMode, type BrowserSessionMode } from './browser-session-mode'

export function BrowserSessionPreference({ userId }: { userId: string }) {
  const [mode, setMode] = useBrowserSessionMode(userId)
  return <div className="mt-2 space-y-1 text-xs text-muted-foreground">
    <label className="inline-flex items-center gap-2">
      Open accounts in
      <select aria-label="Browser for account links" value={mode} onChange={event => setMode(event.target.value as BrowserSessionMode)}
        className="rounded border border-border bg-background px-2 py-1 text-foreground">
        <option value="current">My current browser</option>
        <option value="separate">Separate account profiles</option>
      </select>
    </label>
    <p>{mode === 'current'
      ? 'Uses your saved passwords and Google sign-ins. The provider may keep its current account; switch accounts there if needed.'
      : 'Keeps each account signed in separately in Chrome on your paired Mac.'}</p>
  </div>
}
