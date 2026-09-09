export const NPM_PACKAGE_NAME = 'codex-usage-dashboard'
// npm still carries 0.1.8, which has no `use`, `publish-login` or pool
// sync. Publishing needs the maintainer's own npm login, so every generated
// command installs the pinned release straight from GitHub. Move this back to
// `npx codex-usage-dashboard@latest` once npm carries 0.3.0 or newer.
export const CLI_RELEASE_TAG = 'v0.3.0'
export const CLI_INSTALL_SPEC = `github:tario-you/codex-usage#${CLI_RELEASE_TAG}`
export const NPX_COMMAND = `npx --yes "${CLI_INSTALL_SPEC}"`
export const DASHBOARD_CONNECTED_QUERY_KEY = 'connected'

interface DashboardAuthUrlOptions {
  tokenHash: string
  verificationType: string
}

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

export function buildConnectedDashboardAuthUrl(
  origin: string,
  options: DashboardAuthUrlOptions,
) {
  const url = new URL(buildConnectedDashboardUrl(origin))
  url.searchParams.set('token_hash', options.tokenHash)
  url.searchParams.set('type', options.verificationType)
  return url.toString()
}

function normalizeSiteOrigin(siteUrl: string) {
  return new URL(siteUrl).origin
}

export function buildPublishLoginCommand() {
  return `${NPX_COMMAND} publish-login`
}

export function buildUseLoginCommand(claimUrl: string) {
  return `${NPX_COMMAND} use "${claimUrl}"`
}

export function buildUseLoginWatchCommand() {
  return `${NPX_COMMAND} use --watch`
}

export function buildPublishAllLoginsCommand() {
  return `${NPX_COMMAND} publish-login --all`
}
