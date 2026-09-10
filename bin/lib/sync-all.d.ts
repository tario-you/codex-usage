export interface SyncAllResult {
  email: string
  ok: boolean
  planType?: string | null
  reason?: string
  usedPercent?: number | null
}
export function expiredEmailsFromResults(results: SyncAllResult[] | null | undefined): string[]
export function resolveStorePath(option?: string | null): string
export function buildSyncPayloadFromUsage(data: unknown, email?: string | null): { accountState: unknown; rateLimits: unknown }
