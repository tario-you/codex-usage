import type { User } from '@supabase/supabase-js'

import { serviceRoleSupabase } from './supabase.js'

export async function requireUser(request: Request) {
  const authorization = request.headers.get('authorization')
  const accessToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : null

  if (!accessToken) {
    throw new Error('Missing Authorization header.')
  }

  const { data, error } = await serviceRoleSupabase.auth.getUser(accessToken)
  if (error || !data.user) {
    throw new Error('Your session is no longer valid. Sign in again.')
  }

  return data.user
}

export function hasGoogleIdentity(user: User) {
  if (user.app_metadata?.provider === 'google') {
    return true
  }

  const providers = Array.isArray(user.app_metadata?.providers)
    ? user.app_metadata.providers
    : []
  if (providers.includes('google')) {
    return true
  }

  return (
    user.identities?.some((identity) => identity.provider === 'google') ?? false
  )
}
