import { isClaudeAccountKey } from '../../shared/codex'

/** Owner-specified ratio: one Codex ProLite has one quarter of a Pro's capacity.
 * Other plan types keep their existing units; this does not infer Claude tiers.
 */
export function weeklyPlanCapacity(account: {
  account_key?: string | null
  plan_type?: string | null
}) {
  return !isClaudeAccountKey(account.account_key) && account.plan_type?.trim().toLowerCase() === 'prolite'
    ? 25
    : 100
}
