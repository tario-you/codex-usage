import { useEffect, useState } from 'react'
import { Button } from './ui/button'

// Long-lived dashboard tabs refresh their data, but keep old JavaScript until reloaded.
export function AppUpdateNotice() {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!import.meta.env.PROD) return
    let active = true
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const response = await fetch('/version.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
        if (!response.ok) return
        const data = await response.json()
        if (active && typeof data.version === 'string' && data.version !== import.meta.env.VITE_APP_VERSION) setAvailable(true)
      } catch { /* Retry when online; usage remains available. */ }
    }
    void check()
    const timer = window.setInterval(() => void check(), 60_000)
    window.addEventListener('focus', check)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', check) }
  }, [])
  if (!available) return null
  return <div role="status" className="flex items-center justify-center gap-3 border-b border-border bg-background px-4 py-2 text-sm text-foreground">
    <span>A dashboard update is ready. Reload to use the latest features.</span>
    <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Reload</Button>
  </div>
}
