import { isClaudeAccountKey } from '../../shared/codex'

export type UsageVisibility = Record<'codex' | 'claude', boolean>
export const DEFAULT_USAGE_VISIBILITY: UsageVisibility = { codex: true, claude: false }
const STORAGE_KEY = 'codex-usage.provider-visibility'

export function readUsageVisibility(): UsageVisibility {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (typeof saved?.codex === 'boolean' && typeof saved?.claude === 'boolean') {
      return { codex: saved.codex, claude: saved.claude }
    }
  } catch { /* Use the default when browser storage is unavailable or invalid. */ }
  return { ...DEFAULT_USAGE_VISIBILITY }
}

export function saveUsageVisibility(visible: UsageVisibility) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(visible)) }
  catch { /* The selection still applies for this page when storage is blocked. */ }
}

export function filterUsageAccounts<T extends { account_key: string }>(accounts: T[], visible: UsageVisibility): T[] {
  return accounts.filter((account) => visible[isClaudeAccountKey(account.account_key) ? 'claude' : 'codex'])
}
