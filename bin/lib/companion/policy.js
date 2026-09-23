// Only structured transport/server errors are eligible. Never infer permission
// or safety decisions from prose, and never retry quota, auth, or policy stops.
export function transientFailure(turn) {
  if (turn?.status !== 'failed' || turn.error?.misalignment != null) return false
  const info = turn.error?.codexErrorInfo
  const code = typeof info === 'string' ? info : info && Object.keys(info).length === 1 ? Object.keys(info)[0] : null
  const detail = typeof info === 'object' ? info?.[code] : null
  const status = detail?.httpStatusCode
  if (status != null && (!Number.isInteger(status) || status < 500 || status > 599)) return false
  if (code === 'httpConnectionFailed') return status >= 500 && status <= 599
  return ['responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts', 'internalServerError', 'serverOverloaded'].includes(code)
}

export function unchangedFailure(thread, turnId) {
  const last = thread?.turns?.at(-1)
  return thread?.archived !== true && !thread?.parentThreadId
    && ['idle', 'systemError'].includes(thread?.status?.type)
    && !(thread.status.activeFlags?.length)
    && last?.id === turnId && transientFailure(last)
}

export const RETRY_DELAYS = [30_000, 120_000, 300_000]
export const RETRY_WINDOW_MS = 60 * 60_000
export const CONTINUATION = 'Continue the existing task after its connection or server failure. First inspect the latest task and working state to avoid repeating completed actions. Preserve the original scope, selected model, permissions, and any pending approval. Do not proceed past a pause or a request for user input.'
