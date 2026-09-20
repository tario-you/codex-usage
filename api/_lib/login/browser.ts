import { z } from 'zod'
import { requireUser } from '../auth.js'
import { errorResponse, jsonResponse } from '../http.js'
import { findActiveDeviceByToken, findOwnedAccountById, sharedLoginErrorResponse } from '../login-store.js'
import { serviceRoleSupabase as db } from '../supabase.js'
import { isClaudeAccountKey } from '../../../src/shared/codex.js'

const requestSchema = z.object({ accountId: z.string().uuid(), deviceId: z.string().uuid(), loginMethod: z.enum(['email', 'google']).default('email') })
const pollSchema = z.object({ deviceToken: z.string().min(1) })
const doneSchema = pollSchema.extend({ requestId: z.string().uuid(), outcome: z.enum(['opened', 'failed']) })
const freshSince = () => new Date(Date.now() - 30_000).toISOString()

export async function GET(request: Request) {
  try {
    const user = await requireUser(request)
    const id = new URL(request.url).searchParams.get('requestId')
    if (id) {
      if (!z.string().uuid().safeParse(id).success) return errorResponse('Invalid request.')
      const { data, error } = await db.from('codex_browser_launches').select('id, state, expires_at')
        .eq('id', id).eq('owner_user_id', user.id).maybeSingle()
      if (error) throw error
      if (!data) return errorResponse('Request not found.', 404)
      const state = ['queued', 'opening'].includes(data.state) && Date.parse(data.expires_at) < Date.now() ? 'expired' : data.state
      return jsonResponse({ state })
    }
    const { data, error } = await db.from('codex_devices').select('id, label, machine_name')
      .eq('owner_user_id', user.id).is('revoked_at', null).gte('browser_agent_seen_at', freshSince())
    if (error) throw error
    return jsonResponse({ devices: data ?? [] })
  } catch (error) { return sharedLoginErrorResponse(error, 'Unable to load browser helper.') }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request)
    const parsed = requestSchema.safeParse(await request.json())
    if (!parsed.success) return errorResponse('Choose an account and a machine.')
    const account = await findOwnedAccountById(user.id, parsed.data.accountId)
    if (!account || !z.string().email().safeParse(account.email).success) return errorResponse('This account is not yours or has no email.', 403)
    const { data: device, error: deviceError } = await db.from('codex_devices').select('id')
      .eq('id', parsed.data.deviceId).eq('owner_user_id', user.id).is('revoked_at', null)
      .gte('browser_agent_seen_at', freshSince()).maybeSingle()
    if (deviceError) throw deviceError
    if (!device) return errorResponse('The browser helper is offline on that machine.', 409)
    const { error: expiredError } = await db.from('codex_browser_launches').update({ state: 'expired' })
      .eq('device_id', device.id).eq('state', 'queued').lt('expires_at', new Date().toISOString())
    if (expiredError) throw expiredError
    const { data, error } = await db.from('codex_browser_launches').insert({
      account_id: account.id, owner_user_id: user.id, device_id: device.id,
      email: account.email!, provider: isClaudeAccountKey(account.account_key) ? 'claude' : 'codex',
      login_method: parsed.data.loginMethod,
    }).select('id').single()
    if (error?.code === '23505') return errorResponse('A browser launch is already queued on that machine.', 409)
    if (error) throw error
    return jsonResponse({ requestId: data.id })
  } catch (error) { return sharedLoginErrorResponse(error, 'Unable to open account.') }
}

export async function POLL(request: Request) {
  try {
    const parsed = pollSchema.safeParse(await request.json())
    if (!parsed.success) return errorResponse('Device token required.')
    const device = await findActiveDeviceByToken(parsed.data.deviceToken)
    if (!device) return errorResponse('Unknown or revoked device.', 401)
    const now = new Date().toISOString()
    const { error: heartbeatError } = await db.from('codex_devices').update({ browser_agent_seen_at: now }).eq('id', device.id)
    if (heartbeatError) throw heartbeatError
    const { data: pending, error } = await db.from('codex_browser_launches').select('id')
      .eq('device_id', device.id).eq('owner_user_id', device.owner_user_id).eq('state', 'queued')
      .gt('expires_at', now).order('created_at').limit(1).maybeSingle()
    if (error) throw error
    if (!pending) return jsonResponse({ pending: null })
    // Claim before replying. Two helpers cannot both open the same click.
    const { data: claimed, error: claimError } = await db.from('codex_browser_launches').update({ state: 'opening' })
      .eq('id', pending.id).eq('state', 'queued').gt('expires_at', now)
      .select('id, provider, email, login_method, expires_at').maybeSingle()
    if (claimError) throw claimError
    return jsonResponse({ pending: claimed })
  } catch (error) { return sharedLoginErrorResponse(error, 'Unable to poll browser requests.') }
}

export async function DONE(request: Request) {
  try {
    const parsed = doneSchema.safeParse(await request.json())
    if (!parsed.success) return errorResponse('Invalid browser result.')
    const device = await findActiveDeviceByToken(parsed.data.deviceToken)
    if (!device) return errorResponse('Unknown or revoked device.', 401)
    const { error } = await db.from('codex_browser_launches').update({ state: parsed.data.outcome })
      .eq('id', parsed.data.requestId).eq('device_id', device.id).eq('owner_user_id', device.owner_user_id).eq('state', 'opening')
    if (error) throw error
    return jsonResponse({ ok: true })
  } catch (error) { return sharedLoginErrorResponse(error, 'Unable to record browser result.') }
}
