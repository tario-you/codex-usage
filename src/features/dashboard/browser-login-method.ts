export type BrowserLoginMethod = 'email' | 'google'

export function resolveBrowserLoginMethod(saved: string | null, hasGoogleCredential: boolean): BrowserLoginMethod {
  if (saved === 'email' || saved === 'google') return saved
  return hasGoogleCredential ? 'google' : 'email'
}
