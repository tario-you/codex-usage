import type { BrowserLoginMethod } from './browser-login-method'

export function browserLoginUrl(provider: 'codex' | 'claude', email: string, method: BrowserLoginMethod) {
  const url = new URL(provider === 'codex' ? 'https://chatgpt.com/auth/login_with' : 'https://claude.ai/login')
  const normalizedEmail = email.trim().toLowerCase()
  if (provider === 'codex') {
    url.searchParams.set('login_hint', normalizedEmail)
    url.searchParams.set('screen_hint', 'login')
    url.searchParams.set('callback_path', '/')
    if (method === 'google') url.searchParams.set('connection', 'google-oauth2')
  } else {
    url.searchParams.set('email', normalizedEmail)
  }
  return url.toString()
}
