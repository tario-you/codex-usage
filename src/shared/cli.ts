export const NPM_PACKAGE_NAME = 'codex-usage-dashboard'
export const NPX_COMMAND = `npx ${NPM_PACKAGE_NAME}@latest`
export const DASHBOARD_CONNECTED_QUERY_KEY = 'connected'

export function buildConnectCommand(siteUrl: string) {
  return `${NPX_COMMAND} connect --site "${normalizeSiteOrigin(siteUrl)}"`
}

export function buildPairCommand(pairUrl: string) {
  return `${NPX_COMMAND} pair "${pairUrl}"`
}

export function buildSyncCommand() {
  return `${NPX_COMMAND} sync --watch`
}

export function buildConnectedDashboardUrl(origin: string) {
  const url = new URL('/', origin)
  url.searchParams.set(DASHBOARD_CONNECTED_QUERY_KEY, '1')
  return url.toString()
}

function normalizeSiteOrigin(siteUrl: string) {
  return new URL(siteUrl).origin
}
