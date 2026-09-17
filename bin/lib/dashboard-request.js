/**
 * Every request the agent makes to the dashboard is bounded. On 2026-09-17 a
 * stalled connection left the watch loop without a sync pass for 75 minutes:
 * a freshly connected plan showed "signed in" on the dashboard while its row
 * never arrived. Node's fetch waits minutes on a hung socket unless told not to.
 */
export const DASHBOARD_REQUEST_TIMEOUT_MS = 30_000
export const DASHBOARD_UPLOAD_TIMEOUT_MS = 60_000

/** POST JSON to the dashboard with a timeout; the body is stringified here. */
export function dashboardRequest(body, { timeoutMs = DASHBOARD_REQUEST_TIMEOUT_MS } = {}) {
  return {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
  }
}
