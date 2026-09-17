export const DASHBOARD_REQUEST_TIMEOUT_MS: number
export const DASHBOARD_UPLOAD_TIMEOUT_MS: number
export function dashboardRequest(
  body: unknown,
  options?: { timeoutMs?: number },
): { body: string; headers: Record<string, string>; method: 'POST'; signal: AbortSignal }
