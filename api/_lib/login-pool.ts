import type { CodexRateLimitsResponse } from '../../src/shared/codex.js'
import { type PoolAccount } from './login-pool-choice.js'
import type { LoginSecretRow } from './login-store.js'
import { persistSnapshotForAccount } from './persistence.js'
import { serviceRoleSupabase } from './supabase.js'

export {
  chooseNextAccount,
  serializePoolDecision,
  usablePercent,
  type PoolAccount,
  type PoolDecision,
} from './login-pool-choice.js'

/** Every published account of this owner with its latest dashboard usage row. */
export async function loadPoolAccounts(ownerUserId: string) {
  const { data: secrets, error: secretsError } = await serviceRoleSupabase
    .from('codex_login_secrets')
    .select('*')
    .eq('owner_user_id', ownerUserId)

  if (secretsError) {
    throw secretsError
  }

  const secretsByAccountId = new Map<string, LoginSecretRow>(
    (secrets ?? []).map((secret) => [secret.account_id, secret]),
  )
  const accountIds = [...secretsByAccountId.keys()]
  const accounts: PoolAccount[] = []

  if (accountIds.length > 0) {
    const { data: rows, error } = await serviceRoleSupabase
      .from('codex_dashboard_accounts')
      .select(
        'id, account_key, email, label, plan_type, primary_remaining_percent, primary_resets_at, primary_used_percent, primary_window_mins, secondary_remaining_percent, secondary_resets_at, secondary_used_percent, secondary_window_mins',
      )
      .in('id', accountIds)

    if (error) {
      throw error
    }

    for (const row of rows ?? []) {
      accounts.push(row)
    }
  }

  return { accounts, secretsByAccountId }
}

export async function persistGrantRateLimits({
  accountId,
  grantId,
  rateLimits,
}: {
  accountId: string
  grantId: string
  rateLimits: CodexRateLimitsResponse
}) {
  await persistSnapshotForAccount({
    accountId,
    rateLimits,
    sourceKey: `grant_${grantId}`,
  })
}

