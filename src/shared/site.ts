export const DEFAULT_HOSTED_DASHBOARD_ORIGIN =
  'https://codex-use-age-tario-yous-projects.vercel.app'

export function getPreferredDashboardOrigin(currentOrigin?: string) {
  if (!currentOrigin) {
    return DEFAULT_HOSTED_DASHBOARD_ORIGIN
  }

  return isLocalOrigin(currentOrigin)
    ? new URL(currentOrigin).origin
    : DEFAULT_HOSTED_DASHBOARD_ORIGIN
}

export function getPreferredDashboardHref(currentHref: string) {
  const currentUrl = new URL(currentHref)
  const preferredOrigin = getPreferredDashboardOrigin(currentUrl.origin)

  if (preferredOrigin === currentUrl.origin) {
    return currentUrl.toString()
  }

  const nextUrl = new URL(currentUrl.pathname || '/', preferredOrigin)
  nextUrl.search = currentUrl.search
  nextUrl.hash = currentUrl.hash
  return nextUrl.toString()
}

function isLocalOrigin(value: string) {
  try {
    const url = new URL(value)
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '0.0.0.0'
    )
  } catch {
    return false
  }
}
