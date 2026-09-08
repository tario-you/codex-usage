import { requireUser } from '../auth.js'
import { jsonResponse } from '../http.js'
import {
  listSharesForOwner,
  sharedLoginErrorResponse,
} from '../login-store.js'

/** Dashboard read: which logins this owner publishes, and who holds them. */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request)
    const shares = await listSharesForOwner(user.id)

    return jsonResponse(shares)
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to load shared logins.')
  }
}
