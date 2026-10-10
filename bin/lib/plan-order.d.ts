export interface UsePlan {
  cancelled?: boolean
  accessLost?: boolean
  connectionStatus?: string | null
  checkedAt?: number | null
  planType?: string | null
  available?: boolean
  exhausted?: boolean
  credits?: number
  weeklySpent?: boolean
  provider?: number
  expiresAt?: number | null
  endsAt?: number | null
  returnsAt?: number | null
  usablePercent?: number | null
  label?: string | null
}
export function isUsablePlan(plan: UsePlan, now?: number): boolean
export function planEligible(planType: string | null | undefined): boolean | null
export function planWeight(planType: string | null | undefined): number
export function resetPriority(plan: UsePlan, now: number): { lastChance: boolean; savedMs: number; score: number }
export function useGroup(plan: UsePlan, now: number): number
export function comparePlansForUse(left: UsePlan, right: UsePlan, now: number): number
export function orderPlansForUse<T extends UsePlan>(plans: T[], options?: { now?: number }): T[]
