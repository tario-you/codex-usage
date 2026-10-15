import { AuthClient } from '@supabase/auth-js'
import { PostgrestClient } from '@supabase/postgrest-js'

import type { Database } from './database.types'

// The browser signs in and reads tables; it never uses realtime, storage or functions. So it builds the auth and
// table clients alone instead of createClient, which pulls all of them (about 80 KB) into the first script. Options,
// the storage key and the token on each read match createClient's, so a saved sign-in carries over.
export function createDashboardClient(url: string, key: string, fetchImpl: typeof fetch = (...args) => fetch(...args)) {
  const trimmed = url.trim()
  const baseUrl = new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`)
  const auth = new AuthClient({
    url: new URL('auth/v1', baseUrl).href,
    headers: { Authorization: `Bearer ${key}`, apikey: key },
    storageKey: `sb-${baseUrl.hostname.split('.')[0]}-auth-token`,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    flowType: 'implicit',
    fetch: fetchImpl,
  })
  const fetchWithAuth: typeof fetch = async (input, init) => {
    const { data } = await auth.getSession()
    const headers = new Headers(init?.headers)
    if (!headers.has('apikey')) headers.set('apikey', key)
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${data.session?.access_token ?? key}`)
    return fetchImpl(input, { ...init, headers })
  }
  const rest = new PostgrestClient<Database>(new URL('rest/v1', baseUrl).href, { fetch: fetchWithAuth })

  return {
    auth,
    from: rest.from.bind(rest) as typeof rest.from,
    rpc: rest.rpc.bind(rest) as typeof rest.rpc,
  }
}
