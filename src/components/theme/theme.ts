import { createContext, useContext } from 'react'

const THEME_STORAGE_KEY = 'codex-usage-theme'
const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]
export type ResolvedTheme = Exclude<ThemePreference, 'system'>

interface ThemeContextValue {
  theme: ThemePreference
  resolvedTheme: ResolvedTheme
  setTheme: (theme: ThemePreference) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

function isThemePreference(value: string | null): value is ThemePreference {
  return (
    value !== null &&
    THEME_PREFERENCES.includes(value as ThemePreference)
  )
}

export function getSystemTheme(): ResolvedTheme {
  if (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark'
  }

  return 'light'
}

function getStoredTheme(): ThemePreference | null {
  if (typeof window === 'undefined') {
    return null
  }

  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
  return isThemePreference(storedTheme) ? storedTheme : null
}

export function resolveTheme(
  theme: ThemePreference,
  systemTheme: ResolvedTheme = getSystemTheme(),
): ResolvedTheme {
  return theme === 'system' ? systemTheme : theme
}

export function applyTheme(
  theme: ThemePreference,
  systemTheme: ResolvedTheme = getSystemTheme(),
) {
  if (typeof document === 'undefined') {
    return
  }

  const resolvedTheme = resolveTheme(theme, systemTheme)
  const root = document.documentElement

  root.classList.toggle('dark', resolvedTheme === 'dark')
  root.style.colorScheme = resolvedTheme
  root.dataset.theme = theme
}

export function getInitialTheme(): ThemePreference {
  return getStoredTheme() ?? 'system'
}

export function initializeTheme() {
  applyTheme(getInitialTheme())
}

export function useTheme() {
  const context = useContext(ThemeContext)

  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider.')
  }

  return context
}
