import type { DashboardAccountRow, DashboardWeeklyUsageHistoryPoint, UsageProvider } from '../../lib/dashboard'
import { isClaudeAccountKey } from '../../shared/codex'
import { forecastWeeklyUsage } from './usage-forecast'

export const USAGE_PROVIDERS = [
  { key: 'codex', label: 'Codex', color: '#3b82f6' },
  { key: 'claude', label: 'Claude', color: '#f97316' },
] as const
export const DEFAULT_USAGE_VISIBILITY: Record<UsageProvider, boolean> = { codex: true, claude: false }

export function buildProviderSeries(
  points: DashboardWeeklyUsageHistoryPoint[],
  accounts: DashboardAccountRow[],
  visible: Record<UsageProvider, boolean>,
) {
  return USAGE_PROVIDERS.filter((provider) => visible[provider.key]).map((provider) => {
    const history = points.filter((point) => point.provider === provider.key)
      .sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt))
    const plans = accounts.filter((account) =>
      isClaudeAccountKey(account.account_key) === (provider.key === 'claude'))
    return {
      ...provider,
      points: history,
      capacityPercent: Math.max(plans.length * 100, history.at(-1)?.totalCapacityPercent ?? 0),
      projection: forecastWeeklyUsage(history, plans),
    }
  })
}
export type UsageProviderSeries = ReturnType<typeof buildProviderSeries>[number]
