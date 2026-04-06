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
