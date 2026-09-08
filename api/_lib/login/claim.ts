import { z } from 'zod'

import { getPreferredDashboardOrigin } from '../../../src/shared/site.js'
import { errorResponse, jsonResponse } from '../http.js'
import {
  SHARED_LOGIN_SYNC_POLL_MS,
  findSecretByAccountId,
  openSecret,
  sharedLoginDeviceSchema,
  sharedLoginErrorResponse,
} from '../login-store.js'
import { createOpaqueToken, hashToken } from '../security.js'
import { serviceRoleSupabase } from '../supabase.js'

const claimBodySchema = z.object({
  claimToken: z.string().min(1).optional(),
  device: sharedLoginDeviceSchema,
})

/**
 * Recipient side. A single-use claim link turns into the encrypted login plus a
 * revocable access token the recipient's `use --watch` uses to stay in sync.
 */
export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const body = claimBodySchema.parse(await request.json().catch(() => ({})))
    const claimToken = url.searchParams.get('token') ?? body.claimToken ?? null

    if (!claimToken) {
      return errorResponse('Missing claim token.', 400)
    }

    const { data: grant, error: grantError } = await serviceRoleSupabase
      .from('codex_login_grants')
      .select('*')
      .eq('claim_token_hash', hashToken(claimToken))
      .maybeSingle()

    if (grantError) {
      throw grantError
    }

    if (!grant) {
      return errorResponse('This login link is invalid.', 404)
    }

    if (grant.status === 'revoked') {
      return errorResponse('This login link was revoked.', 409)
    }

    if (grant.status !== 'pending') {
      return errorResponse('This login link has already been used.', 409)
    }

    if (Date.parse(grant.expires_at) <= Date.now()) {
      await serviceRoleSupabase
        .from('codex_login_grants')
        .update({ status: 'expired' })
        .eq('id', grant.id)

      return errorResponse('This login link has expired.', 410)
    }

    const secret = await findSecretByAccountId(grant.account_id)
    if (!secret) {
      return errorResponse('This login is no longer shared.', 410)
    }

    const authFile = openSecret(secret)
    const accessToken = createOpaqueToken(32)
    const nowIso = new Date().toISOString()
    const machineName = body.device?.machineName ?? null

    const { error: updateError } = await serviceRoleSupabase
      .from('codex_login_grants')
      .update({
        access_token_hash: hashToken(accessToken),
        claimed_at: nowIso,
        claimed_label: body.device?.label?.trim() || machineName,
        claimed_machine_name: machineName,
        last_synced_at: nowIso,
        status: 'active',
        sync_count: 1,
      })
      .eq('id', grant.id)
      .eq('status', 'pending')

    if (updateError) {
      throw updateError
    }

    const dashboardOrigin = getPreferredDashboardOrigin(url.origin)

    return jsonResponse({
      accessToken,
      account: {
        accountId: secret.account_id,
        email: secret.account_email,
        planType: secret.plan_type,
      },
      authFile,
      dashboardOrigin,
      fingerprint: secret.fingerprint,
      issuedAt: secret.token_issued_at,
      ok: true,
      pollMs: SHARED_LOGIN_SYNC_POLL_MS,
      syncUrl: `${url.origin}/api/login/sync`,
    })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to claim this login.')
  }
}
