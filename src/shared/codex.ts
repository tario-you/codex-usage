export interface CodexCreditsSnapshot {
  balance: string | null
  hasCredits: boolean
  unlimited: boolean
}

export interface CodexRateLimitWindow {
  usedPercent: number
  resetsAt: number | null
  windowDurationMins: number | null
}

export interface CodexRateLimitSnapshot {
  credits: CodexCreditsSnapshot | null
  limitId: string | null
  limitName: string | null
  planType: string | null
  primary: CodexRateLimitWindow | null
  secondary: CodexRateLimitWindow | null
}

export interface CodexRateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null
}

export interface CodexChatGptAccount {
  email?: string
  planType?: string
  type: 'chatgpt'
}

export interface CodexApiKeyAccount {
  type: 'apiKey'
}

export interface CodexAccountReadResponse {
  account: CodexApiKeyAccount | CodexChatGptAccount | null
  requiresOpenaiAuth: boolean
}

export const FRESHNESS_WINDOW_MS = 15 * 60 * 1000

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  month: 'short',
})

export function getRemainingPercent(usedPercent: number | null | undefined) {
  if (usedPercent == null) {
    return null
  }

  return Math.max(0, Math.min(100, 100 - usedPercent))
}

export function parseCreditsBalance(balance: string | null | undefined) {
  if (!balance) {
    return null
  }

  const parsed = Number.parseFloat(balance)
  return Number.isFinite(parsed) ? parsed : null
}

export function formatWindowLabel(windowDurationMins: number | null | undefined) {
  if (windowDurationMins == null) {
    return 'Unknown window'
  }

  if (windowDurationMins === 300) {
    return '5-hour'
  }

  if (windowDurationMins === 10080) {
    return 'Weekly'
  }

  if (windowDurationMins < 60) {
    return `${windowDurationMins}m`
  }

  if (windowDurationMins % 60 === 0) {
    return `${windowDurationMins / 60}h`
  }

  return `${windowDurationMins}m`
}

export function formatTimestamp(value: Date | string | null | undefined) {
  if (!value) {
    return 'Never'
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Never'
  }

  return dateFormatter.format(date)
}

export function formatRelativeTimestamp(value: Date | string | null | undefined) {
  if (!value) {
    return 'Never synced'
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Never synced'
  }

  const deltaMs = Date.now() - date.getTime()
  const deltaMinutes = Math.round(deltaMs / 60000)

  if (deltaMinutes <= 1) {
    return 'Just now'
  }

  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`
  }

  const deltaHours = Math.round(deltaMinutes / 60)
  if (deltaHours < 24) {
    return `${deltaHours}h ago`
  }

  return formatTimestamp(date)
}

export function unixSecondsToIso(value: number | null | undefined) {
  if (value == null) {
    return null
  }

  return new Date(value * 1000).toISOString()
}

export function isFreshTimestamp(
  value: Date | string | null | undefined,
  freshnessWindowMs = FRESHNESS_WINDOW_MS,
) {
  if (!value) {
    return false
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return false
  }

  return Date.now() - date.getTime() <= freshnessWindowMs
}
