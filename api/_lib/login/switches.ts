import { requireUser } from '../auth.js'
import { jsonResponse } from '../http.js'
import { SharedLoginError } from '../login-reconcile.js'
import { findActiveDeviceByToken, sharedLoginErrorResponse } from '../login-store.js'
import { uploadSwitchEventsSchema } from '../switch-events.js'
import { listSwitchEvents, recordSwitchEvents } from '../switch-store.js'

/** Dashboard read: the caller's own switch history. */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request)
    return jsonResponse({ events: await listSwitchEvents(user.id) })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to load the switch history.')
  }
}

/** Owner machine upload: switches, continuations and relaunches from the local switcher. */
export async function POST(request: Request) {
  try {
    const parsed = uploadSwitchEventsSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      throw new SharedLoginError('Switch events must carry a device token and well-formed events.', 400)
    }
    const device = await findActiveDeviceByToken(parsed.data.deviceToken)
    if (!device) {
      throw new SharedLoginError('This machine is not paired with the dashboard.', 401)
    }
    const recorded = await recordSwitchEvents(
      parsed.data.events.map((event) => ({
        ownerUserId: device.owner_user_id,
        source: 'device' as const,
        deviceId: device.id,
        kind: event.kind,
        fromEmail: event.fromEmail ?? null,
        toEmail: event.toEmail ?? null,
        reason: event.reason ?? null,
        occurredAt: event.occurredAt,
      })),
    )
    return jsonResponse({ ok: true, recorded })
  } catch (error) {
    return sharedLoginErrorResponse(error, 'Unable to record the switch history.')
  }
}
