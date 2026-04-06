import { useEffect, useState, type ReactNode } from 'react'

import {
  ThemeContext,
  applyTheme,
  getInitialTheme,
  getSystemTheme,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from './theme'

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemePreference>(() => getInitialTheme())
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    getSystemTheme(),
  )

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    function handleChange(event: MediaQueryListEvent) {
      setSystemTheme(event.matches ? 'dark' : 'light')
    }

    mediaQuery.addEventListener('change', handleChange)

    return () => {
      mediaQuery.removeEventListener('change', handleChange)
    }
  }, [])

  useEffect(() => {
    applyTheme(theme, systemTheme)
    window.localStorage.setItem('codex-usage-theme', theme)
  }, [systemTheme, theme])

  return (
    <ThemeContext.Provider
      value={{
        theme,
        resolvedTheme: resolveTheme(theme, systemTheme),
        setTheme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  )
}
