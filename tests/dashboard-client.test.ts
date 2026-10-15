import assert from 'node:assert/strict'
import test from 'node:test'

import { createClient } from '@supabase/supabase-js'

import { createDashboardClient } from '../src/lib/dashboard-client'

const url = 'https://example-ref.supabase.co'
const key = 'anon-key'

function recorder() {
  const requests: { url: string; headers: Record<string, string> }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    requests.push({ url: String(input), headers: { apikey: headers.apikey, authorization: headers.authorization } })
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, requests }
}

async function readTables(client: { from: ReturnType<typeof createDashboardClient>['from']; rpc: ReturnType<typeof createDashboardClient>['rpc'] }) {
  await client.from('codex_dashboard_accounts').select('*').order('last_snapshot_at', { ascending: false, nullsFirst: false })
  await client.rpc('list_dashboard_inviters')
}

test('the dashboard client keeps createClient\'s sign-in storage and sends the same reads', async () => {
  const ours = recorder()
  const theirs = recorder()
  const dashboard = createDashboardClient(url, key, ours.fetchImpl)
  const reference = createClient(url, key, { auth: { autoRefreshToken: true, persistSession: true }, global: { fetch: theirs.fetchImpl } })
  try {
    const fields = ['storageKey', 'url', 'flowType', 'detectSessionInUrl', 'autoRefreshToken', 'persistSession', 'hasCustomAuthorizationHeader'] as const
    for (const field of fields) {
      assert.deepEqual((dashboard.auth as never)[field], (reference.auth as never)[field], field)
    }
    assert.equal(dashboard.auth['storageKey'], 'sb-example-ref-auth-token', 'a saved sign-in is found under the same key')

    await readTables(dashboard)
    await readTables(reference as never)
    assert.deepEqual(ours.requests, theirs.requests)
    assert.equal(ours.requests[0].headers.authorization, `Bearer ${key}`)

    dashboard.auth.getSession = async () => ({ data: { session: { access_token: 'user-token' } }, error: null }) as never
    await dashboard.from('codex_dashboard_accounts').select('*')
    assert.equal(ours.requests.at(-1)?.headers.authorization, 'Bearer user-token', 'a signed-in read carries the user\'s token')
  } finally {
    await dashboard.auth.stopAutoRefresh()
    await reference.auth.stopAutoRefresh()
  }
})
