import { z } from 'zod'

import { requireUser } from '../auth.js'
import { jsonResponse } from '../http.js'
import { SharedLoginError } from '../login-reconcile.js'
import { sharedLoginErrorResponse } from '../login-store.js'
import { createOpaqueToken, hashToken } from '../security.js'
import { serviceRoleSupabase } from '../supabase.js'
import { listSwitchEvents } from '../switch-store.js'
import {
  getDashboardWeeklyUsageBucketSeconds,
  getDashboardWeeklyUsageRangeDays,
  type DashboardWeeklyUsageRange,
} from '../../../src/features/dashboard/usage-history-ranges.js'
import { getRemainingPercent } from '../../../src/shared/codex.js'

/**
 * Samantha for Mac shows this dashboard on her own page (her-team#5389, #5390). The owner allows it once
 * here; her server trades the one-time code for a reader token and reads with it what the dashboard reads,
 * as the owner. A reader changes nothing: it is not a machine, so it never syncs, switches or signs in.
 *
 *   POST /api/login/reader/start   (the owner's session) { returnTo, state } -> { url }: back to her page with a code
 *   POST /api/login/reader/claim   { code } -> { token }: once, within 10 minutes; older readers for that page end
 *   GET  /api/login/reader/feed?range=1d|7d|30d   (Bearer reader token) -> { accounts, history, switches, readAt }
 *   POST /api/login/reader/revoke  (Bearer reader token) -> { ok }
 */
export const READER_CODE_TTL_MS = 10 * 60 * 1000
export const READER_LABEL = 'Samantha for Mac'
// Her servers' own hosts, and only their Mac page's return path (structural: an allow list, never a pattern of words).
export const READER_RETURN_HOSTS = new Set(['her-tario.moonshot.computer', 'her.moonshot.computer'])
const RETURN_PATH = /^\/mac\/[a-f0-9]{32}\/codexusage\/back$/
const RANGES = new Set<DashboardWeeklyUsageRange>(['1d', '7d', '30d'])

/** The page a code may go back to, or null. */
export function readerReturnUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 300) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !READER_RETURN_HOSTS.has(url.hostname) || url.port || url.search || url.hash) return null
    return RETURN_PATH.test(url.pathname) ? url : null
  } catch {
    return null
  }
}

const startSchema = z.object({ returnTo: z.string().min(1).max(300), state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) })
const claimSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/) })

export async function START(request: Request) {
  try {
    const user = await requireUser(request)
    const parsed = startSchema.safeParse(await request.json().catch(() => null))
    const returnTo = parsed.success ? readerReturnUrl(parsed.data.returnTo) : null
    if (!parsed.success || !returnTo) throw new SharedLoginError('That is not a Samantha page this dashboard can send you back to.', 400)
    const code = createOpaqueToken(32)
    const { error } = await serviceRoleSupabase.from('codex_readers').insert({
      owner_user_id: user.id,
      label: READER_LABEL,
      return_origin: returnTo.origin,
      code_hash: hashToken(code),
      code_expires_at: new Date(Date.now() + READER_CODE_TTL_MS).toISOString(),
    })
    if (error) throw new SharedLoginError('Unable to allow Samantha right now. Try again.', 500)
    returnTo.searchParams.set('code', code)
    returnTo.searchParams.set('state', parsed.data.state)
    return jsonResponse({ url: returnTo.toString() })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to allow Samantha right now.')
  }
}

export async function CLAIM(request: Request) {
  try {
    const parsed = claimSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) throw new SharedLoginError('That code is not valid.', 400)
    const token = createOpaqueToken(32)
    const nowIso = new Date().toISOString()
    // One claim per code: the update only matches an unclaimed, unexpired, unrevoked code.
    const { data, error } = await serviceRoleSupabase.from('codex_readers')
      .update({ token_hash: hashToken(token), claimed_at: nowIso, code_hash: null, code_expires_at: null })
      .eq('code_hash', hashToken(parsed.data.code))
      .is('token_hash', null)
      .is('revoked_at', null)
      .gt('code_expires_at', nowIso)
      .select('id, owner_user_id, return_origin')
      .maybeSingle()
    if (error) throw new SharedLoginError('Unable to finish allowing Samantha. Try again.', 500)
    if (!data) throw new SharedLoginError('That code has expired or was already used. Allow Samantha again.', 410)
    // One reader per Samantha page: the ones it replaces stop reading.
    await serviceRoleSupabase.from('codex_readers').update({ revoked_at: nowIso })
      .eq('owner_user_id', data.owner_user_id).eq('return_origin', data.return_origin).neq('id', data.id).is('revoked_at', null)
    return jsonResponse({ token, label: READER_LABEL })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to finish allowing Samantha.')
  }
}

async function readerFor(request: Request) {
  const authorization = request.headers.get('authorization') ?? ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!token) throw new SharedLoginError('Missing reader token.', 401)
  const { data, error } = await serviceRoleSupabase.from('codex_readers').select('id, owner_user_id')
    .eq('token_hash', hashToken(token)).is('revoked_at', null).maybeSingle()
  if (error) throw new SharedLoginError('Unable to read the dashboard right now.', 500)
  if (!data) throw new SharedLoginError('This reader is no longer allowed. Allow Samantha again from her page.', 401)
  return data
}

// What her page shows of each row; the machine paths and source keys stay here.
const ACCOUNT_FIELDS = ['id', 'access_scope', 'account_key', 'email', 'label', 'plan_type', 'plan_started_at', 'metadata', 'last_seen_at',
  'last_snapshot_at', 'primary_used_percent', 'primary_remaining_percent', 'primary_remaining_overridden', 'primary_window_mins',
  'primary_resets_at', 'secondary_used_percent', 'secondary_remaining_percent', 'secondary_remaining_overridden', 'secondary_window_mins',
  'secondary_resets_at', 'raw_rate_limits'] as const

export async function FEED(request: Request) {
  try {
    const reader = await readerFor(request)
    const asked = new URL(request.url).searchParams.get('range') as DashboardWeeklyUsageRange
    const range = RANGES.has(asked) ? asked : '7d'
    const rangeStart = new Date(Date.now() - getDashboardWeeklyUsageRangeDays(range) * 24 * 60 * 60 * 1000).toISOString()
    const history = (provider: 'codex' | 'claude') => serviceRoleSupabase.rpc('reader_weighted_weekly_usage_history', {
      reader_owner: reader.owner_user_id, range_start: rangeStart, usage_provider: provider,
      bucket_seconds: getDashboardWeeklyUsageBucketSeconds(range),
    })
    const [accounts, codex, claude, switches] = await Promise.all([
      serviceRoleSupabase.rpc('reader_dashboard_accounts', { reader_owner: reader.owner_user_id }),
      history('codex'), history('claude'), listSwitchEvents(reader.owner_user_id),
    ])
    if (accounts.error || codex.error || claude.error) throw new SharedLoginError('Unable to read the dashboard right now.', 500)
    await serviceRoleSupabase.from('codex_readers').update({ last_read_at: new Date().toISOString() }).eq('id', reader.id)
    const point = (provider: 'codex' | 'claude') => (row: { fetched_at: string; total_remaining_percent: number; account_count: number; total_capacity_percent: number }) => ({
      provider, accountCount: row.account_count, fetchedAt: row.fetched_at,
      totalCapacityPercent: Number(row.total_capacity_percent), totalRemainingPercent: Number(row.total_remaining_percent),
    })
    return jsonResponse({
      readAt: new Date().toISOString(),
      range,
      accounts: (accounts.data ?? []).map((row) => ({
        ...Object.fromEntries(ACCOUNT_FIELDS.map((field) => [field, row[field] ?? null])),
        // The dashboard's own normalisation (lib/dashboard.ts normalizeDashboardAccountRow).
        primary_remaining_percent: row.primary_used_percent == null ? null : getRemainingPercent(row.primary_used_percent),
        secondary_remaining_percent: row.secondary_used_percent == null ? null : getRemainingPercent(row.secondary_used_percent),
      })),
      history: [...(codex.data ?? []).map(point('codex')), ...(claude.data ?? []).map(point('claude'))],
      switches,
    }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to read the dashboard right now.')
  }
}

export async function REVOKE(request: Request) {
  try {
    const reader = await readerFor(request)
    await serviceRoleSupabase.from('codex_readers').update({ revoked_at: new Date().toISOString() }).eq('id', reader.id)
    return jsonResponse({ ok: true })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to stop the reader.')
  }
}
