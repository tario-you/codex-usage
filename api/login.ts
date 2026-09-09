import { errorResponse } from './_lib/http.js'
import * as claim from './_lib/login/claim.js'
import * as grantsRevoke from './_lib/login/grants-revoke.js'
import * as grantsStart from './_lib/login/grants-start.js'
import * as publish from './_lib/login/publish.js'
import * as shares from './_lib/login/shares.js'
import * as sync from './_lib/login/sync.js'
import * as unpublish from './_lib/login/unpublish.js'

type RouteHandler = (request: Request) => Promise<Response>

/**
 * One Vercel function serves every /api/login/* route. The Hobby plan allows
 * twelve serverless functions per deployment and the dashboard already uses
 * eleven, so the login routes share this function. Vercel's file routing only
 * matched one path segment for a catch-all file, so vercel.json rewrites
 * /api/login/<anything> to /api/login?action=<anything> and the dispatcher
 * reads the action from either the query string or the path.
 */
const loginRoutes: Record<string, RouteHandler> = {
  'GET /api/login/shares': shares.GET,
  'POST /api/login/claim': claim.POST,
  'POST /api/login/grants/revoke': grantsRevoke.POST,
  'POST /api/login/grants/start': grantsStart.POST,
  'POST /api/login/publish': publish.POST,
  'POST /api/login/sync': sync.POST,
  'POST /api/login/unpublish': unpublish.POST,
}

export function resolveLoginRoute(method: string, pathname: string) {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/'
  return loginRoutes[`${method.toUpperCase()} ${normalizedPath}`] ?? null
}

export function loginPathnameFor(url: URL) {
  const action = url.searchParams.get('action')
  return action ? `/api/login/${action.replace(/^\/+/, '')}` : url.pathname
}

async function dispatch(request: Request) {
  const handler = resolveLoginRoute(request.method, loginPathnameFor(new URL(request.url)))
  if (!handler) {
    return errorResponse('Not found.', 404)
  }

  return handler(request)
}

export function GET(request: Request) {
  return dispatch(request)
}

export function POST(request: Request) {
  return dispatch(request)
}
