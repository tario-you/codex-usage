export interface ResetPlanState {
  cancelled: boolean
  credits: number
  endsAt: number | null
  exhausted: boolean
  id: string
  planType: string | null
  returnsAt: number | null
}
export interface ResetCreditTarget {
  lastChance: boolean
  plan: ResetPlanState
  savedMs: number
  score: number
}
export type ResetSpendDecision =
  | ({ action: 'spend' } & ResetCreditTarget)
  | { action: 'wait'; reason: 'no-plans' | 'no-credits' }
  | { action: 'wait'; reason: 'usage-left'; plan: ResetPlanState }
export const RESET_CONSUME_URL: string
export const RESET_SPEND_COOLDOWN_MS: number
export function planWeight(planType: string | null | undefined): number
export function resetCreditTarget(plans: ResetPlanState[], options?: { now?: number }): ResetCreditTarget | null
export function planResetSpend(plans: ResetPlanState[], options?: { now?: number }): ResetSpendDecision
export function resetPlanFromUsage(id: string, data: unknown, account?: unknown): ResetPlanState
export function consumeResetCredit(
  tokens: { access_token: string; account_id: string },
  options?: { fetcher?: typeof fetch; redeemRequestId?: string },
): Promise<{ outcome: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed' | null; error?: string }>
export function formatWait(ms: number): string
